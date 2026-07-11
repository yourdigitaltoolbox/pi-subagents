import { randomUUID } from "node:crypto";
import type { ChildExposureIntentSource, ChildExposureMode, ChildRuntimeIdentity } from "./child-session-contract.ts";
export { RELAY_RUNNER_DELEGATION_ENV, RELAY_RUNNER_SOCKET_ENV } from "./relay-runner-env.ts";

export const RELAY_EXPOSURE_RPC_VERSION = 1 as const;
export const RELAY_EXPOSURE_REQUEST_EVENT = "remote-pi:relay-exposure:v1:request";
export const RELAY_EXPOSURE_REPLY_EVENT_PREFIX = "remote-pi:relay-exposure:v1:reply:";
export const RELAY_EXPOSURE_CAPABILITY_ENV = "PI_SUBAGENT_RELAY_EXPOSURE_CAPABILITY";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^rpel1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/;
const RUNNER_DELEGATION_PATTERN = /^rprd1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/;
const IDENTITY_KEYS = new Set(["workspaceId", "agentId", "processEpoch"]);
const BINDING_KEYS = new Set(["runId", "workspaceId", "agentId", "processEpoch", "mode"]);
const LEASE_KEYS = new Set(["relayExposureLeaseId", "parent", "binding", "issuedAt", "expiresAt"]);
const ISSUE_SUCCESS_REPLY_KEYS = new Set(["version", "requestId", "success", "ok", "capability", "lease"]);
const LIFECYCLE_SUCCESS_REPLY_KEYS = new Set(["version", "requestId", "success", "ok", "state", "lease"]);
const RUNNER_DELEGATE_SUCCESS_REPLY_KEYS = new Set([
	"version", "requestId", "success", "ok", "token", "socketPath",
	"expiresAt", "maxLeaseTtlMs", "maxChildIssues",
]);
const FAILURE_REPLY_KEYS = new Set(["version", "requestId", "success", "reason"]);
const FAILURE_FIELD_REPLY_KEYS = new Set([...FAILURE_REPLY_KEYS, "field"]);
const FAILURE_REASONS = new Set([
	"unauthorized_parent",
	"delegation_expired",
	"invalid_binding",
	"invalid_ttl",
	"invalid_renewal_id",
	"renewal_capacity_exceeded",
	"ttl_exceeds_maximum",
	"ttl_exceeds_delegation",
	"parent_capacity_exceeded",
	"authority_capacity_exceeded",
	"lease_already_exists",
	"lease_not_found",
	"lease_not_active",
	"invalid_close_reason",
	"stale_child_connection",
	"invalid_request",
	"local_mesh_unavailable",
	"invalid_broker_reply",
	"broker_unavailable",
	"binding_mismatch",
	"target_not_found",
	"target_epoch_mismatch",
	"activation_failed",
	"invalid_runner_scope",
	"invalid_child_issue_limit",
	"runner_delegation_capacity_exceeded",
	"policy_denied",
]);
const BINDING_FIELDS = new Set(["runId", "workspaceId", "agentId", "processEpoch", "mode"]);
const MAX_RUN_ID_BYTES = 512;
const MAX_REASON_LENGTH = 128;

export interface RelayExposureBinding extends ChildRuntimeIdentity {
	runId: string;
	processEpoch: string;
	mode: "relay";
}

export interface RelayExposureLeaseMetadata {
	relayExposureLeaseId: string;
	parent: ChildRuntimeIdentity & { processEpoch: string };
	binding: RelayExposureBinding;
	issuedAt: number;
	expiresAt: number;
}

export type RelayExposureNormalCloseReason = "completed" | "interrupted" | "timeout" | "controlled_shutdown";

export interface RelayExposureEventBus {
	on(channel: string, handler: (value: unknown) => void): (() => void) | void;
	emit(channel: string, value: unknown): void;
}

export type RelayExposureRequestResult =
	| { ok: true; capability: string; lease: RelayExposureLeaseMetadata }
	| { ok: false; reason: string };

export type RelayExposureLifecycleResult =
	| { ok: true; state: "promoted" | "renewed" | "revoked" | "closed" | "idempotent"; lease: RelayExposureLeaseMetadata }
	| { ok: false; reason: string; field?: keyof RelayExposureBinding };

export type RelayRunnerDelegationResult =
	| { ok: true; token: string; socketPath: string; expiresAt: number; maxLeaseTtlMs: number; maxChildIssues: number }
	| { ok: false; reason: string };

function hasExactKeys(value: object, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
}

export function isRelayExposureCapability(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = CAPABILITY_PATTERN.exec(value);
	return match !== null && UUID_PATTERN.test(match[1]!);
}

/** Remote policy fallback may need to ask remote-pi even though its safe wire value is local. */
export function relayIntentMayNeedAuthority(
	exposure: ChildExposureMode | undefined,
	intentSource: ChildExposureIntentSource | undefined,
): boolean {
	return exposure === "relay" || (exposure !== "off" && intentSource === "fallback");
}

/** Explicit extension allowlists disable package discovery; never hand a bearer to a child that omitted remote-pi. */
export function explicitExtensionSelectionLoadsRemotePi(extensions: readonly string[] | undefined): boolean {
	if (extensions === undefined) return true;
	return extensions.some((entry) => {
		const normalized = entry.trim().replace(/\\/g, "/");
		return /(?:^|[/:@])remote[-_]pi(?:$|[/.@:])/i.test(normalized);
	});
}

function capabilityLeaseId(capability: string): string | undefined {
	const match = CAPABILITY_PATTERN.exec(capability);
	return match && UUID_PATTERN.test(match[1]!) ? match[1]!.toLowerCase() : undefined;
}

export function relayExposureReplyEvent(requestId: string): string {
	if (!UUID_PATTERN.test(requestId)) throw new Error("Relay exposure RPC requestId must be a UUID.");
	return `${RELAY_EXPOSURE_REPLY_EVENT_PREFIX}${requestId.toLowerCase()}`;
}

function sameBinding(left: RelayExposureBinding, right: RelayExposureBinding): boolean {
	return left.runId === right.runId
		&& left.workspaceId.toLowerCase() === right.workspaceId.toLowerCase()
		&& left.agentId.toLowerCase() === right.agentId.toLowerCase()
		&& left.processEpoch.toLowerCase() === right.processEpoch.toLowerCase()
		&& left.mode === right.mode;
}

function validIdentity(value: unknown): value is ChildRuntimeIdentity & { processEpoch: string } {
	if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, IDENTITY_KEYS)) return false;
	const identity = value as Record<string, unknown>;
	return typeof identity.workspaceId === "string" && UUID_PATTERN.test(identity.workspaceId)
		&& typeof identity.agentId === "string" && UUID_PATTERN.test(identity.agentId)
		&& typeof identity.processEpoch === "string" && UUID_PATTERN.test(identity.processEpoch);
}

function validBinding(value: unknown): value is RelayExposureBinding {
	if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, BINDING_KEYS)) return false;
	const binding = value as Record<string, unknown>;
	return typeof binding.runId === "string"
		&& binding.runId.trim().length > 0
		&& Buffer.byteLength(binding.runId, "utf8") <= MAX_RUN_ID_BYTES
		&& validIdentity({
			workspaceId: binding.workspaceId,
			agentId: binding.agentId,
			processEpoch: binding.processEpoch,
		})
		&& binding.mode === "relay";
}

function validLeaseMetadata(
	value: unknown,
	requested: RelayExposureBinding,
	expectedLeaseId: string,
	now: number,
	requireFresh: boolean,
): value is RelayExposureLeaseMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, LEASE_KEYS)) return false;
	const lease = value as Record<string, unknown>;
	return typeof lease.relayExposureLeaseId === "string"
		&& UUID_PATTERN.test(lease.relayExposureLeaseId)
		&& lease.relayExposureLeaseId.toLowerCase() === expectedLeaseId.toLowerCase()
		&& validIdentity(lease.parent)
		&& validBinding(lease.binding)
		&& sameBinding(lease.binding, requested)
		&& typeof lease.issuedAt === "number"
		&& Number.isSafeInteger(lease.issuedAt)
		&& typeof lease.expiresAt === "number"
		&& Number.isSafeInteger(lease.expiresAt)
		&& lease.expiresAt > lease.issuedAt
		&& (!requireFresh || lease.expiresAt > now);
}

function cloneLease(metadata: RelayExposureLeaseMetadata): RelayExposureLeaseMetadata {
	return {
		relayExposureLeaseId: metadata.relayExposureLeaseId.toLowerCase(),
		parent: {
			workspaceId: metadata.parent.workspaceId.toLowerCase(),
			agentId: metadata.parent.agentId.toLowerCase(),
			processEpoch: metadata.parent.processEpoch.toLowerCase(),
		},
		binding: {
			runId: metadata.binding.runId,
			workspaceId: metadata.binding.workspaceId.toLowerCase(),
			agentId: metadata.binding.agentId.toLowerCase(),
			processEpoch: metadata.binding.processEpoch.toLowerCase(),
			mode: "relay",
		},
		issuedAt: metadata.issuedAt,
		expiresAt: metadata.expiresAt,
	};
}

function parseFailure(reply: Record<string, unknown>): { ok: false; reason: string; field?: keyof RelayExposureBinding } | undefined {
	if (reply.success !== false) return undefined;
	const hasField = "field" in reply;
	if (!hasExactKeys(reply, hasField ? FAILURE_FIELD_REPLY_KEYS : FAILURE_REPLY_KEYS)) {
		return { ok: false, reason: "invalid_reply" };
	}
	if (typeof reply.reason !== "string"
		|| reply.reason.length === 0
		|| reply.reason.length > MAX_REASON_LENGTH
		|| !FAILURE_REASONS.has(reply.reason)) return { ok: false, reason: "invalid_reply" };
	if (reply.reason === "binding_mismatch" && !hasField) return { ok: false, reason: "invalid_reply" };
	if (hasField) {
		if (reply.reason !== "binding_mismatch"
			|| typeof reply.field !== "string"
			|| !BINDING_FIELDS.has(reply.field)) return { ok: false, reason: "invalid_reply" };
		return { ok: false, reason: reply.reason, field: reply.field as keyof RelayExposureBinding };
	}
	return { ok: false, reason: reply.reason };
}

function parseRunnerDelegateReply(
	value: unknown,
	requestId: string,
	options: { delegationTtlMs: number; maxLeaseTtlMs: number; maxChildIssues: number },
	now: number,
): RelayRunnerDelegationResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const reply = value as Record<string, unknown>;
	if (reply.version !== 1 || reply.requestId !== requestId) return undefined;
	const failure = parseFailure(reply);
	if (failure) return "field" in failure ? { ok: false, reason: "invalid_reply" } : failure;
	const tokenMatch = typeof reply.token === "string" ? RUNNER_DELEGATION_PATTERN.exec(reply.token) : null;
	if (reply.success !== true
		|| reply.ok !== true
		|| !hasExactKeys(reply, RUNNER_DELEGATE_SUCCESS_REPLY_KEYS)
		|| !tokenMatch
		|| !UUID_PATTERN.test(tokenMatch[1]!)
		|| typeof reply.socketPath !== "string"
		|| reply.socketPath.length === 0
		|| Buffer.byteLength(reply.socketPath, "utf8") > 4096
		|| reply.socketPath.includes("\0")
		|| typeof reply.expiresAt !== "number"
		|| !Number.isSafeInteger(reply.expiresAt)
		|| reply.expiresAt <= now
		|| reply.expiresAt > now + options.delegationTtlMs
		|| reply.maxLeaseTtlMs !== options.maxLeaseTtlMs
		|| reply.maxChildIssues !== options.maxChildIssues) return { ok: false, reason: "invalid_reply" };
	return {
		ok: true,
		token: reply.token as string,
		socketPath: reply.socketPath,
		expiresAt: reply.expiresAt,
		maxLeaseTtlMs: reply.maxLeaseTtlMs as number,
		maxChildIssues: reply.maxChildIssues as number,
	};
}

function parseIssueReply(
	value: unknown,
	requestId: string,
	requested: RelayExposureBinding,
	now: number,
): RelayExposureRequestResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const reply = value as Record<string, unknown>;
	if (reply.version !== 1 || reply.requestId !== requestId) return undefined;
	const failure = parseFailure(reply);
	if (failure) return "field" in failure ? { ok: false, reason: "invalid_reply" } : failure;
	if (reply.success !== true
		|| reply.ok !== true
		|| !hasExactKeys(reply, ISSUE_SUCCESS_REPLY_KEYS)
		|| !isRelayExposureCapability(reply.capability)) return { ok: false, reason: "invalid_reply" };
	const leaseId = capabilityLeaseId(reply.capability);
	if (!leaseId || !validLeaseMetadata(reply.lease, requested, leaseId, now, true)) {
		return { ok: false, reason: "invalid_reply" };
	}
	return { ok: true, capability: reply.capability, lease: cloneLease(reply.lease) };
}

function parsePromoteReply(
	value: unknown,
	requestId: string,
	binding: RelayExposureBinding,
	now: number,
): RelayExposureLifecycleResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const reply = value as Record<string, unknown>;
	if (reply.version !== 1 || reply.requestId !== requestId) return undefined;
	const failure = parseFailure(reply);
	if (failure) return failure;
	if (reply.success !== true
		|| reply.ok !== true
		|| !hasExactKeys(reply, LIFECYCLE_SUCCESS_REPLY_KEYS)
		|| (reply.state !== "promoted" && reply.state !== "idempotent")
		|| !reply.lease
		|| typeof reply.lease !== "object"
		|| Array.isArray(reply.lease)) return { ok: false, reason: "invalid_reply" };
	const leaseId = (reply.lease as Record<string, unknown>).relayExposureLeaseId;
	if (typeof leaseId !== "string"
		|| !UUID_PATTERN.test(leaseId)
		|| !validLeaseMetadata(reply.lease, binding, leaseId, now, true)) {
		return { ok: false, reason: "invalid_reply" };
	}
	return {
		ok: true,
		state: reply.state,
		lease: cloneLease(reply.lease),
	};
}

function parseLifecycleReply(
	value: unknown,
	requestId: string,
	method: "renew" | "revoke" | "close",
	lease: RelayExposureLeaseMetadata,
	now: number,
): RelayExposureLifecycleResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const reply = value as Record<string, unknown>;
	if (reply.version !== 1 || reply.requestId !== requestId) return undefined;
	const failure = parseFailure(reply);
	if (failure) return failure;
	const allowedStates = method === "renew"
		? new Set(["renewed", "idempotent"])
		: method === "revoke"
			? new Set(["revoked", "idempotent"])
			: new Set(["closed", "idempotent"]);
	if (reply.success !== true
		|| reply.ok !== true
		|| !hasExactKeys(reply, LIFECYCLE_SUCCESS_REPLY_KEYS)
		|| typeof reply.state !== "string"
		|| !allowedStates.has(reply.state)
		|| !validLeaseMetadata(
			reply.lease,
			lease.binding,
			lease.relayExposureLeaseId,
			now,
			method === "renew",
		)) return { ok: false, reason: "invalid_reply" };
	return {
		ok: true,
		state: reply.state as "renewed" | "revoked" | "closed" | "idempotent",
		lease: cloneLease(reply.lease),
	};
}

function performRpc<T>(
	events: RelayExposureEventBus,
	requestId: string,
	request: Record<string, unknown>,
	parse: (raw: unknown) => T | undefined,
	timeoutMs: number,
): Promise<T | { ok: false; reason: string }> {
	const replyChannel = relayExposureReplyEvent(requestId);
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const finish = (result: T | { ok: false; reason: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { unsubscribe?.(); } catch { /* best effort */ }
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
		try {
			const maybeUnsubscribe = events.on(replyChannel, (raw) => {
				const parsed = parse(raw);
				if (parsed) finish(parsed);
			});
			if (typeof maybeUnsubscribe === "function") unsubscribe = maybeUnsubscribe;
			events.emit(RELAY_EXPOSURE_REQUEST_EVENT, request);
		} catch {
			finish({ ok: false, reason: "event_bus_error" });
		}
	});
}

/** Obtain one bounded broker-memory token for a trusted detached async runner. */
export function delegateRelayRunner(
	events: RelayExposureEventBus,
	options: {
		rootRunId: string;
		workspaceId: string;
		delegationTtlMs: number;
		maxLeaseTtlMs: number;
		maxChildIssues: number;
		intentSources?: readonly ChildExposureIntentSource[];
		timeoutMs?: number;
		now?: () => number;
	},
): Promise<RelayRunnerDelegationResult> {
	if (typeof options.rootRunId !== "string"
		|| !options.rootRunId.trim()
		|| Buffer.byteLength(options.rootRunId, "utf8") > MAX_RUN_ID_BYTES
		|| !UUID_PATTERN.test(options.workspaceId)
		|| !Number.isSafeInteger(options.delegationTtlMs)
		|| options.delegationTtlMs <= 0
		|| !Number.isSafeInteger(options.maxLeaseTtlMs)
		|| options.maxLeaseTtlMs <= 0
		|| !Number.isSafeInteger(options.maxChildIssues)
		|| options.maxChildIssues <= 0) {
		return Promise.resolve({ ok: false, reason: "invalid_request" });
	}
	const intentSources = options.intentSources ?? ["run"];
	if (!Array.isArray(intentSources)
		|| intentSources.length === 0
		|| intentSources.length > 3
		|| intentSources.some((source) => source !== "run" && source !== "agent" && source !== "fallback")
		|| new Set(intentSources).size !== intentSources.length) {
		return Promise.resolve({ ok: false, reason: "invalid_request" });
	}
	const requestId = randomUUID();
	return performRpc(
		events,
		requestId,
		{
			version: 1,
			requestId,
			method: "delegate_runner",
			rootRunId: options.rootRunId,
			workspaceId: options.workspaceId,
			delegationTtlMs: options.delegationTtlMs,
			maxLeaseTtlMs: options.maxLeaseTtlMs,
			maxChildIssues: options.maxChildIssues,
			intentSources: [...intentSources],
		},
		(raw) => parseRunnerDelegateReply(raw, requestId, options, (options.now ?? Date.now)()),
		options.timeoutMs ?? 250,
	) as Promise<RelayRunnerDelegationResult>;
}

/** Ask the exact delegated live parent connection to promote one current child. */
export function promoteRelayExposureLease(
	events: RelayExposureEventBus,
	binding: RelayExposureBinding,
	options: { ttlMs: number; timeoutMs?: number; now?: () => number },
): Promise<RelayExposureLifecycleResult> {
	if (!validBinding(binding) || !Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
		return Promise.resolve({ ok: false, reason: "invalid_request" });
	}
	const requestId = randomUUID();
	return performRpc(
		events,
		requestId,
		{ version: 1, requestId, method: "promote", binding: { ...binding }, ttlMs: options.ttlMs },
		(raw) => parsePromoteReply(raw, requestId, binding, (options.now ?? Date.now)()),
		options.timeoutMs ?? 250,
	) as Promise<RelayExposureLifecycleResult>;
}

/** Ask the co-loaded remote-pi parent extension for one process bearer. */
export function requestRelayExposureLease(
	events: RelayExposureEventBus,
	binding: RelayExposureBinding,
	options: { ttlMs: number; intentSource?: ChildExposureIntentSource; timeoutMs?: number; now?: () => number },
): Promise<RelayExposureRequestResult> {
	if (!validBinding(binding) || !Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
		return Promise.resolve({ ok: false, reason: "invalid_request" });
	}
	const requestId = randomUUID();
	return performRpc(
		events,
		requestId,
		{ version: 1, requestId, method: "issue", binding: { ...binding }, ttlMs: options.ttlMs, intentSource: options.intentSource ?? "run" },
		(raw) => parseIssueReply(raw, requestId, binding, (options.now ?? Date.now)()),
		options.timeoutMs ?? 250,
	) as Promise<RelayExposureRequestResult>;
}

export function renewRelayExposureLease(
	events: RelayExposureEventBus,
	lease: RelayExposureLeaseMetadata,
	options: { ttlMs: number; renewalId?: string; timeoutMs?: number; now?: () => number },
): Promise<RelayExposureLifecycleResult> {
	const renewalId = options.renewalId ?? randomUUID();
	if (!UUID_PATTERN.test(renewalId) || !Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
		return Promise.resolve({ ok: false, reason: "invalid_request" });
	}
	const requestId = randomUUID();
	return performRpc(
		events,
		requestId,
		{
			version: 1,
			requestId,
			method: "renew",
			relayExposureLeaseId: lease.relayExposureLeaseId,
			renewalId,
			binding: { ...lease.binding },
			ttlMs: options.ttlMs,
		},
		(raw) => parseLifecycleReply(raw, requestId, "renew", lease, (options.now ?? Date.now)()),
		options.timeoutMs ?? 250,
	) as Promise<RelayExposureLifecycleResult>;
}

export function revokeRelayExposureLease(
	events: RelayExposureEventBus,
	lease: RelayExposureLeaseMetadata,
	options: { timeoutMs?: number; now?: () => number } = {},
): Promise<RelayExposureLifecycleResult> {
	return requestLifecycle(events, "revoke", lease, undefined, options);
}

export function closeRelayExposureLease(
	events: RelayExposureEventBus,
	lease: RelayExposureLeaseMetadata,
	reason: RelayExposureNormalCloseReason,
	options: { timeoutMs?: number; now?: () => number } = {},
): Promise<RelayExposureLifecycleResult> {
	return requestLifecycle(events, "close", lease, reason, options);
}

function requestLifecycle(
	events: RelayExposureEventBus,
	method: "revoke" | "close",
	lease: RelayExposureLeaseMetadata,
	reason: RelayExposureNormalCloseReason | undefined,
	options: { timeoutMs?: number; now?: () => number },
): Promise<RelayExposureLifecycleResult> {
	const requestId = randomUUID();
	const request: Record<string, unknown> = {
		version: 1,
		requestId,
		method,
		relayExposureLeaseId: lease.relayExposureLeaseId,
		binding: { ...lease.binding },
		...(method === "close" ? { reason } : {}),
	};
	return performRpc(
		events,
		requestId,
		request,
		(raw) => parseLifecycleReply(raw, requestId, method, lease, (options.now ?? Date.now)()),
		options.timeoutMs ?? 250,
	) as Promise<RelayExposureLifecycleResult>;
}
