import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type {
	RelayExposureBinding,
	RelayExposureLeaseMetadata,
	RelayExposureNormalCloseReason,
} from "../shared/relay-exposure.ts";
import type { ChildExposureIntentSource } from "../shared/child-session-contract.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNNER_TOKEN_PATTERN = /^rprd1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/;
const CAPABILITY_PATTERN = /^rpel1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/;
const MAX_REPLY_BYTES = 64 * 1024;
const FAILURE_KEYS = new Set(["type", "version", "requestId", "ok", "reason"]);
const FAILURE_FIELD_KEYS = new Set([...FAILURE_KEYS, "field"]);
const FAILURE_LEASE_KEYS = new Set([...FAILURE_KEYS, "lease"]);
const ISSUE_SUCCESS_KEYS = new Set(["type", "version", "requestId", "ok", "state", "capability", "lease"]);
const LIFECYCLE_SUCCESS_KEYS = new Set(["type", "version", "requestId", "ok", "state", "lease"]);
const RELEASE_SUCCESS_KEYS = new Set(["type", "version", "requestId", "ok", "state"]);
const LEASE_KEYS = new Set(["relayExposureLeaseId", "parent", "binding", "issuedAt", "expiresAt"]);
const IDENTITY_KEYS = new Set(["workspaceId", "agentId", "processEpoch"]);
const BINDING_KEYS = new Set(["runId", "workspaceId", "agentId", "processEpoch", "mode"]);
const BINDING_FIELDS = new Set(["runId", "workspaceId", "agentId", "processEpoch", "mode"]);
const FAILURE_REASONS = new Set([
	"invalid_request",
	"invalid_runner_delegation",
	"runner_delegation_expired",
	"runner_issue_capacity_exceeded",
	"runner_intent_source_denied",
	"ttl_exceeds_runner_maximum",
	"runner_lease_not_owned",
	"runner_binding_mismatch",
	"lease_already_exists",
	"unauthorized_parent",
	"delegation_expired",
	"invalid_binding",
	"invalid_ttl",
	"ttl_exceeds_maximum",
	"ttl_exceeds_delegation",
	"parent_capacity_exceeded",
	"authority_capacity_exceeded",
	"lease_not_found",
	"lease_not_active",
	"invalid_renewal_id",
	"renewal_capacity_exceeded",
	"invalid_close_reason",
	"binding_mismatch",
]);

type Failure = { ok: false; reason: string; field?: keyof RelayExposureBinding };
export type RelayRunnerIssueResult =
	| { ok: true; state: "issued"; capability: string; lease: RelayExposureLeaseMetadata }
	| Failure;
export type RelayRunnerLifecycleResult =
	| { ok: true; state: "renewed" | "revoked" | "closed" | "idempotent"; lease: RelayExposureLeaseMetadata }
	| Failure;
export type RelayRunnerReleaseResult = { ok: true; state: "released" } | Failure;

export interface RelayRunnerClient {
	issue(binding: RelayExposureBinding, ttlMs: number, intentSource: ChildExposureIntentSource): Promise<RelayRunnerIssueResult>;
	renew(lease: RelayExposureLeaseMetadata, ttlMs: number, renewalId?: string): Promise<RelayRunnerLifecycleResult>;
	revoke(lease: RelayExposureLeaseMetadata): Promise<RelayRunnerLifecycleResult>;
	close(lease: RelayExposureLeaseMetadata, reason: RelayExposureNormalCloseReason): Promise<RelayRunnerLifecycleResult>;
	release(): Promise<RelayRunnerReleaseResult>;
}

function exact(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function validBinding(value: unknown): value is RelayExposureBinding {
	const binding = record(value);
	return Boolean(binding
		&& exact(binding, BINDING_KEYS)
		&& typeof binding.runId === "string"
		&& binding.runId.trim()
		&& Buffer.byteLength(binding.runId, "utf8") <= 512
		&& typeof binding.workspaceId === "string" && UUID_PATTERN.test(binding.workspaceId)
		&& typeof binding.agentId === "string" && UUID_PATTERN.test(binding.agentId)
		&& typeof binding.processEpoch === "string" && UUID_PATTERN.test(binding.processEpoch)
		&& binding.mode === "relay");
}

function sameBinding(left: RelayExposureBinding, right: RelayExposureBinding): boolean {
	return left.runId === right.runId
		&& left.workspaceId.toLowerCase() === right.workspaceId.toLowerCase()
		&& left.agentId.toLowerCase() === right.agentId.toLowerCase()
		&& left.processEpoch.toLowerCase() === right.processEpoch.toLowerCase()
		&& left.mode === right.mode;
}

function validLease(value: unknown, binding: RelayExposureBinding, expectedLeaseId?: string): value is RelayExposureLeaseMetadata {
	const lease = record(value);
	const parent = record(lease?.parent);
	return Boolean(lease
		&& exact(lease, LEASE_KEYS)
		&& typeof lease.relayExposureLeaseId === "string"
		&& UUID_PATTERN.test(lease.relayExposureLeaseId)
		&& (!expectedLeaseId || lease.relayExposureLeaseId.toLowerCase() === expectedLeaseId.toLowerCase())
		&& parent
		&& exact(parent, IDENTITY_KEYS)
		&& typeof parent.workspaceId === "string" && UUID_PATTERN.test(parent.workspaceId)
		&& typeof parent.agentId === "string" && UUID_PATTERN.test(parent.agentId)
		&& typeof parent.processEpoch === "string" && UUID_PATTERN.test(parent.processEpoch)
		&& validBinding(lease.binding)
		&& sameBinding(lease.binding, binding)
		&& typeof lease.issuedAt === "number" && Number.isSafeInteger(lease.issuedAt)
		&& typeof lease.expiresAt === "number" && Number.isSafeInteger(lease.expiresAt)
		&& lease.expiresAt > lease.issuedAt);
}

function cloneLease(lease: RelayExposureLeaseMetadata): RelayExposureLeaseMetadata {
	return {
		...lease,
		parent: { ...lease.parent },
		binding: { ...lease.binding },
	};
}

function parseFailure(reply: Record<string, unknown>): Failure | undefined {
	if (reply.ok !== false) return undefined;
	const hasField = "field" in reply;
	const hasLease = "lease" in reply;
	if (!exact(reply, hasField ? FAILURE_FIELD_KEYS : hasLease ? FAILURE_LEASE_KEYS : FAILURE_KEYS)) {
		return { ok: false, reason: "invalid_reply" };
	}
	if (typeof reply.reason !== "string" || !FAILURE_REASONS.has(reply.reason)) return { ok: false, reason: "invalid_reply" };
	if (hasLease) return reply.reason === "lease_already_exists"
		? { ok: false, reason: reply.reason }
		: { ok: false, reason: "invalid_reply" };
	if (hasField) {
		if ((reply.reason !== "binding_mismatch" && reply.reason !== "runner_binding_mismatch")
			|| typeof reply.field !== "string"
			|| !BINDING_FIELDS.has(reply.field)) return { ok: false, reason: "invalid_reply" };
		return { ok: false, reason: reply.reason, field: reply.field as keyof RelayExposureBinding };
	}
	if (reply.reason === "binding_mismatch" || reply.reason === "runner_binding_mismatch") return { ok: false, reason: "invalid_reply" };
	return { ok: false, reason: reply.reason };
}

function parseResponse(
	raw: unknown,
	requestId: string,
	operation: "issue" | "renew" | "revoke" | "close" | "release",
	binding?: RelayExposureBinding,
	leaseId?: string,
): RelayRunnerIssueResult | RelayRunnerLifecycleResult | RelayRunnerReleaseResult {
	const reply = record(raw);
	if (!reply
		|| reply.type !== "relay_runner_result"
		|| reply.version !== 1
		|| reply.requestId !== requestId) return { ok: false, reason: "invalid_reply" };
	const failure = parseFailure(reply);
	if (failure) return failure;
	if (reply.ok !== true) return { ok: false, reason: "invalid_reply" };
	if (operation === "release") {
		return exact(reply, RELEASE_SUCCESS_KEYS) && reply.state === "released"
			? { ok: true, state: "released" }
			: { ok: false, reason: "invalid_reply" };
	}
	if (!binding) return { ok: false, reason: "invalid_reply" };
	if (operation === "issue") {
		const match = typeof reply.capability === "string" ? CAPABILITY_PATTERN.exec(reply.capability) : null;
		if (!exact(reply, ISSUE_SUCCESS_KEYS)
			|| reply.state !== "issued"
			|| !match
			|| !UUID_PATTERN.test(match[1]!)
			|| !validLease(reply.lease, binding, match[1])) return { ok: false, reason: "invalid_reply" };
		return { ok: true, state: "issued", capability: reply.capability as string, lease: cloneLease(reply.lease) };
	}
	const allowedState = operation === "renew"
		? new Set(["renewed", "idempotent"])
		: operation === "revoke"
			? new Set(["revoked", "idempotent"])
			: new Set(["closed", "idempotent"]);
	if (!exact(reply, LIFECYCLE_SUCCESS_KEYS)
		|| typeof reply.state !== "string"
		|| !allowedState.has(reply.state)
		|| !validLease(reply.lease, binding, leaseId)) return { ok: false, reason: "invalid_reply" };
	return {
		ok: true,
		state: reply.state as "renewed" | "revoked" | "closed" | "idempotent",
		lease: cloneLease(reply.lease),
	};
}

export function createRelayRunnerClient(options: { token: string; socketPath: string; timeoutMs?: number }): RelayRunnerClient {
	const tokenMatch = RUNNER_TOKEN_PATTERN.exec(options.token);
	if (!tokenMatch || !UUID_PATTERN.test(tokenMatch[1]!)) throw new Error("Relay runner delegation token has an invalid format.");
	if (!options.socketPath || options.socketPath.includes("\0") || Buffer.byteLength(options.socketPath, "utf8") > 4096) {
		throw new Error("Relay runner broker socket path is invalid.");
	}
	const timeoutMs = options.timeoutMs ?? 2_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Relay runner IPC timeout must be a positive integer.");

	const request = async (
		operation: "issue" | "renew" | "revoke" | "close" | "release",
		body: Record<string, unknown>,
		binding?: RelayExposureBinding,
		leaseId?: string,
	): Promise<RelayRunnerIssueResult | RelayRunnerLifecycleResult | RelayRunnerReleaseResult> => {
		const requestId = randomUUID();
		const payload = { ...body, version: 1, requestId, token: options.token };
		return new Promise((resolve) => {
			let settled = false;
			let buffer = "";
			const socket = createConnection({ path: options.socketPath });
			const finish = (result: RelayRunnerIssueResult | RelayRunnerLifecycleResult | RelayRunnerReleaseResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(result);
			};
			const timer = setTimeout(() => finish({ ok: false, reason: "broker_unavailable" }), timeoutMs);
			timer.unref?.();
			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				if (Buffer.byteLength(buffer, "utf8") > MAX_REPLY_BYTES) {
					finish({ ok: false, reason: "invalid_reply" });
					return;
				}
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				try {
					finish(parseResponse(JSON.parse(buffer.slice(0, newline)), requestId, operation, binding, leaseId));
				} catch {
					finish({ ok: false, reason: "invalid_reply" });
				}
			});
			socket.on("error", () => finish({ ok: false, reason: "broker_unavailable" }));
			socket.on("close", () => {
				if (!settled) finish({ ok: false, reason: "broker_unavailable" });
			});
		});
	};

	return {
		issue(binding, ttlMs, intentSource) {
			if (!validBinding(binding)
				|| !Number.isSafeInteger(ttlMs)
				|| ttlMs <= 0
				|| (intentSource !== "run" && intentSource !== "agent" && intentSource !== "fallback")) {
				return Promise.resolve({ ok: false, reason: "invalid_request" });
			}
			return request("issue", { type: "relay_runner_issue", binding: { ...binding }, ttlMs, intentSource }, binding) as Promise<RelayRunnerIssueResult>;
		},
		renew(lease, ttlMs, renewalId = randomUUID()) {
			if (!validLease(lease, lease.binding, lease.relayExposureLeaseId)
				|| !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !UUID_PATTERN.test(renewalId)) {
				return Promise.resolve({ ok: false, reason: "invalid_request" });
			}
			return request("renew", {
				type: "relay_runner_renew",
				relayExposureLeaseId: lease.relayExposureLeaseId,
				renewalId,
				binding: { ...lease.binding },
				ttlMs,
			}, lease.binding, lease.relayExposureLeaseId) as Promise<RelayRunnerLifecycleResult>;
		},
		revoke(lease) {
			if (!validLease(lease, lease.binding, lease.relayExposureLeaseId)) return Promise.resolve({ ok: false, reason: "invalid_request" });
			return request("revoke", {
				type: "relay_runner_revoke",
				relayExposureLeaseId: lease.relayExposureLeaseId,
				binding: { ...lease.binding },
			}, lease.binding, lease.relayExposureLeaseId) as Promise<RelayRunnerLifecycleResult>;
		},
		close(lease, reason) {
			if (!validLease(lease, lease.binding, lease.relayExposureLeaseId)
				|| (reason !== "completed" && reason !== "interrupted" && reason !== "timeout" && reason !== "controlled_shutdown")) {
				return Promise.resolve({ ok: false, reason: "invalid_request" });
			}
			return request("close", {
				type: "relay_runner_close",
				relayExposureLeaseId: lease.relayExposureLeaseId,
				binding: { ...lease.binding },
				reason,
			}, lease.binding, lease.relayExposureLeaseId) as Promise<RelayRunnerLifecycleResult>;
		},
		release() {
			return request("release", { type: "relay_runner_release" }) as Promise<RelayRunnerReleaseResult>;
		},
	};
}
