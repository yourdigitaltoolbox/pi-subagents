import { randomUUID } from "node:crypto";
import {
	closeRelayExposureLease,
	promoteRelayExposureLease,
	renewRelayExposureLease,
	revokeRelayExposureLease,
	type RelayExposureBinding,
	type RelayExposureEventBus,
	type RelayExposureLeaseMetadata,
	type RelayExposureNormalCloseReason,
} from "../shared/relay-exposure.ts";

const REGISTRY_KEY = Symbol.for("pi-subagents.foreground-relay-exposure.v1");
const RETRYABLE_RENEWAL_FAILURES = new Set(["timeout", "event_bus_error", "broker_unavailable", "invalid_reply"]);
const TERMINAL_STALE_LEASE_FAILURES = new Set(["lease_not_found", "lease_not_active"]);

export type ForegroundRelayExposureActionResult =
	| { ok: true; state: "promoted" | "renewed" | "revoked" | "closed" | "idempotent"; lease?: RelayExposureLeaseMetadata }
	| { ok: false; reason: string; field?: keyof RelayExposureBinding };

export interface ForegroundRelayExposureSnapshot {
	runId: string;
	agent: string;
	index: number;
	parentSessionId?: string;
	binding: RelayExposureBinding;
	lease?: RelayExposureLeaseMetadata;
	closed: boolean;
}

export interface ForegroundRelayExposureController {
	readonly runId: string;
	readonly agent: string;
	readonly index: number;
	readonly parentSessionId?: string;
	readonly binding: RelayExposureBinding;
	relay(ttlMs?: number): Promise<ForegroundRelayExposureActionResult>;
	local(): Promise<ForegroundRelayExposureActionResult>;
	close(reason: RelayExposureNormalCloseReason): Promise<ForegroundRelayExposureActionResult>;
	snapshot(): ForegroundRelayExposureSnapshot;
}

interface ControllerOptions {
	events: RelayExposureEventBus;
	binding: RelayExposureBinding;
	agent: string;
	index: number;
	parentSessionId?: string;
	defaultTtlMs: number;
	initialLease?: RelayExposureLeaseMetadata;
}

function cloneBinding(binding: RelayExposureBinding): RelayExposureBinding {
	return {
		runId: binding.runId,
		workspaceId: binding.workspaceId.toLowerCase(),
		agentId: binding.agentId.toLowerCase(),
		processEpoch: binding.processEpoch.toLowerCase(),
		mode: "relay",
	};
}

function cloneLease(lease: RelayExposureLeaseMetadata): RelayExposureLeaseMetadata {
	return {
		relayExposureLeaseId: lease.relayExposureLeaseId.toLowerCase(),
		parent: {
			workspaceId: lease.parent.workspaceId.toLowerCase(),
			agentId: lease.parent.agentId.toLowerCase(),
			processEpoch: lease.parent.processEpoch.toLowerCase(),
		},
		binding: cloneBinding(lease.binding),
		issuedAt: lease.issuedAt,
		expiresAt: lease.expiresAt,
	};
}

function sameLeaseVersion(left: RelayExposureLeaseMetadata | undefined, right: RelayExposureLeaseMetadata): boolean {
	return left?.relayExposureLeaseId === right.relayExposureLeaseId
		&& left.binding.runId === right.binding.runId
		&& left.binding.workspaceId === right.binding.workspaceId
		&& left.binding.agentId === right.binding.agentId
		&& left.binding.processEpoch === right.binding.processEpoch
		&& left.expiresAt === right.expiresAt;
}

class Controller implements ForegroundRelayExposureController {
	readonly runId: string;
	readonly agent: string;
	readonly index: number;
	readonly parentSessionId?: string;
	readonly binding: RelayExposureBinding;
	private readonly events: RelayExposureEventBus;
	private readonly defaultTtlMs: number;
	private lease?: RelayExposureLeaseMetadata;
	private renewalTimer?: NodeJS.Timeout;
	private renewalRetryTimer?: NodeJS.Timeout;
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private desiredRelay: boolean;
	private intent = 0;
	private closeResult?: Promise<ForegroundRelayExposureActionResult>;

	constructor(options: ControllerOptions) {
		this.events = options.events;
		this.binding = cloneBinding(options.binding);
		this.runId = this.binding.runId;
		this.agent = options.agent;
		this.index = options.index;
		this.parentSessionId = options.parentSessionId;
		this.defaultTtlMs = options.defaultTtlMs;
		this.lease = options.initialLease ? cloneLease(options.initialLease) : undefined;
		this.desiredRelay = this.lease !== undefined;
		if (this.lease) this.scheduleRenewal();
	}

	snapshot(): ForegroundRelayExposureSnapshot {
		return {
			runId: this.runId,
			agent: this.agent,
			index: this.index,
			...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
			binding: cloneBinding(this.binding),
			...(this.lease ? { lease: cloneLease(this.lease) } : {}),
			closed: this.closed,
		};
	}

	relay(ttlMs = this.defaultTtlMs): Promise<ForegroundRelayExposureActionResult> {
		if (this.closed) return Promise.resolve({ ok: false, reason: "controller_closed" });
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return Promise.resolve({ ok: false, reason: "invalid_request" });
		this.desiredRelay = true;
		const intent = ++this.intent;
		this.clearRenewalTimers();
		return this.enqueue(async () => {
			if (this.closed) return { ok: false, reason: "controller_closed" };
			if (!this.desiredRelay || intent !== this.intent) return { ok: false, reason: "superseded" };
			const current = this.lease;
			let result = current && current.expiresAt > Date.now()
				? await renewRelayExposureLease(this.events, current, { ttlMs })
				: await promoteRelayExposureLease(this.events, this.binding, { ttlMs });
			if (!result.ok && current && TERMINAL_STALE_LEASE_FAILURES.has(result.reason)) {
				this.lease = undefined;
				if (!this.closed && this.desiredRelay && intent === this.intent) {
					result = await promoteRelayExposureLease(this.events, this.binding, { ttlMs });
				}
			}
			if (result.ok) {
				this.lease = cloneLease(result.lease);
				if (!this.closed && this.desiredRelay && intent === this.intent) this.scheduleRenewal();
			}
			return result;
		});
	}

	local(): Promise<ForegroundRelayExposureActionResult> {
		if (this.closed) return Promise.resolve({ ok: true, state: "idempotent" });
		this.desiredRelay = false;
		++this.intent;
		this.clearRenewalTimers();
		return this.enqueue(async () => {
			const current = this.lease;
			if (!current || current.expiresAt <= Date.now()) {
				this.lease = undefined;
				return { ok: true, state: "idempotent" };
			}
			const result = await revokeRelayExposureLease(this.events, current);
			if (result.ok) this.lease = undefined;
			if (!result.ok && TERMINAL_STALE_LEASE_FAILURES.has(result.reason)) {
				this.lease = undefined;
				return { ok: true, state: "idempotent" };
			}
			return result;
		});
	}

	close(reason: RelayExposureNormalCloseReason): Promise<ForegroundRelayExposureActionResult> {
		if (this.closeResult) return this.closeResult;
		this.closed = true;
		this.desiredRelay = false;
		++this.intent;
		this.clearRenewalTimers();
		this.closeResult = this.enqueue(async () => {
			const current = this.lease;
			if (!current) return { ok: true, state: "idempotent" };
			const result = await closeRelayExposureLease(this.events, current, reason);
			if (result.ok) this.lease = undefined;
			return result;
		});
		return this.closeResult;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	private clearRenewalTimers(): void {
		if (this.renewalTimer) clearTimeout(this.renewalTimer);
		if (this.renewalRetryTimer) clearTimeout(this.renewalRetryTimer);
		this.renewalTimer = undefined;
		this.renewalRetryTimer = undefined;
	}

	private scheduleRenewal(): void {
		if (this.closed || !this.desiredRelay || !this.lease) return;
		if (this.renewalTimer) clearTimeout(this.renewalTimer);
		const lease = cloneLease(this.lease);
		const delay = Math.max(10, Math.floor((lease.expiresAt - Date.now()) / 2));
		this.renewalTimer = setTimeout(() => {
			this.renewalTimer = undefined;
			this.attemptRenewal(lease, randomUUID());
		}, delay);
		this.renewalTimer.unref?.();
	}

	private attemptRenewal(lease: RelayExposureLeaseMetadata, renewalId: string, retryCount = 0): void {
		if (this.closed || !this.desiredRelay || Date.now() >= lease.expiresAt || !sameLeaseVersion(this.lease, lease)) return;
		void this.enqueue(async () => {
			if (this.closed || !this.desiredRelay || Date.now() >= lease.expiresAt || !sameLeaseVersion(this.lease, lease)) return;
			let result: Awaited<ReturnType<typeof renewRelayExposureLease>>;
			try {
				result = await renewRelayExposureLease(this.events, lease, { ttlMs: this.defaultTtlMs, renewalId });
			} catch {
				if (retryCount < 1) this.scheduleRenewalRetry(lease, renewalId, retryCount + 1);
				return;
			}
			if (result.ok) {
				this.lease = cloneLease(result.lease);
				if (!this.closed && this.desiredRelay) this.scheduleRenewal();
			} else if (TERMINAL_STALE_LEASE_FAILURES.has(result.reason)) {
				this.lease = undefined;
				this.clearRenewalTimers();
			} else if (RETRYABLE_RENEWAL_FAILURES.has(result.reason) && retryCount < 1) {
				this.scheduleRenewalRetry(lease, renewalId, retryCount + 1);
			}
		});
	}

	private scheduleRenewalRetry(lease: RelayExposureLeaseMetadata, renewalId: string, retryCount: number): void {
		if (this.closed || !this.desiredRelay || this.renewalRetryTimer || !sameLeaseVersion(this.lease, lease)) return;
		const remainingMs = lease.expiresAt - Date.now();
		if (remainingMs <= 0) return;
		const delay = Math.max(10, Math.min(250, Math.floor(remainingMs / 4)));
		this.renewalRetryTimer = setTimeout(() => {
			this.renewalRetryTimer = undefined;
			if (!this.closed && this.desiredRelay && Date.now() < lease.expiresAt) this.attemptRenewal(lease, renewalId, retryCount);
		}, delay);
		this.renewalRetryTimer.unref?.();
	}
}

function registry(): Map<string, ForegroundRelayExposureController> {
	const root = globalThis as Record<PropertyKey, unknown>;
	const existing = root[REGISTRY_KEY];
	if (existing instanceof Map) return existing as Map<string, ForegroundRelayExposureController>;
	const created = new Map<string, ForegroundRelayExposureController>();
	root[REGISTRY_KEY] = created;
	return created;
}

function controllerKey(runId: string, index: number): string {
	return `${runId}\u0000${index}`;
}

export function createForegroundRelayExposureController(options: ControllerOptions): ForegroundRelayExposureController {
	return new Controller(options);
}

export function registerForegroundRelayExposureController(controller: ForegroundRelayExposureController): void {
	const key = controllerKey(controller.runId, controller.index);
	const existing = registry().get(key);
	if (existing && existing !== controller) throw new Error(`Relay exposure controller already exists for ${controller.runId}#${controller.index}.`);
	registry().set(key, controller);
}

export function unregisterForegroundRelayExposureController(controller: ForegroundRelayExposureController): void {
	const key = controllerKey(controller.runId, controller.index);
	if (registry().get(key) === controller) registry().delete(key);
}

export function resolveForegroundRelayExposureController(input: {
	runId: string;
	index?: number;
	parentSessionId?: string;
}): { controller?: ForegroundRelayExposureController; error?: string } {
	const requested = input.runId.trim().toLowerCase();
	if (!requested) return { error: "action='exposure' requires a run id." };
	if (!input.parentSessionId?.trim()) return { error: "Live foreground relay exposure requires an exact current parent session." };
	const allControllers = [...registry().values()];
	const inSession = allControllers.filter((controller) =>
		controller.parentSessionId === input.parentSessionId
		&& (input.index === undefined || controller.index === input.index),
	);
	const exact = inSession.filter((controller) => controller.runId.toLowerCase() === requested);
	const matches = exact.length > 0 ? exact : inSession.filter((controller) => controller.runId.toLowerCase().startsWith(requested));
	if (matches.length === 1) return { controller: matches[0] };
	if (matches.length > 1) return { error: `Multiple live foreground children match '${input.runId}'. Pass an exact id and index.` };
	const wrongSession = allControllers.some((controller) =>
		(controller.runId.toLowerCase() === requested || controller.runId.toLowerCase().startsWith(requested))
		&& (input.index === undefined || controller.index === input.index),
	);
	return { error: wrongSession
		? `Live foreground relay exposure target '${input.runId}' belongs to a different parent session.`
		: `No live foreground relay exposure controller found for '${input.runId}'${input.index === undefined ? "" : ` index ${input.index}`}.` };
}
