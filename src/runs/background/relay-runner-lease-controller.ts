import { randomUUID } from "node:crypto";
import type {
	RelayExposureLeaseMetadata,
	RelayExposureNormalCloseReason,
} from "../shared/relay-exposure.ts";
import type {
	RelayRunnerClient,
	RelayRunnerLifecycleResult,
} from "./relay-runner-client.ts";

const RETRYABLE_FAILURES = new Set(["broker_unavailable", "invalid_reply"]);
const TERMINAL_FAILURES = new Set([
	"invalid_runner_delegation",
	"runner_delegation_expired",
	"runner_lease_not_owned",
	"lease_not_found",
	"lease_not_active",
]);

function cloneLease(lease: RelayExposureLeaseMetadata): RelayExposureLeaseMetadata {
	return { ...lease, parent: { ...lease.parent }, binding: { ...lease.binding } };
}

function sameLeaseRevision(left: RelayExposureLeaseMetadata | undefined, right: RelayExposureLeaseMetadata): boolean {
	return left?.relayExposureLeaseId.toLowerCase() === right.relayExposureLeaseId.toLowerCase()
		&& left.expiresAt === right.expiresAt
		&& left.binding.processEpoch.toLowerCase() === right.binding.processEpoch.toLowerCase();
}

export function relayCloseReasonForAsyncRun(run: {
	timedOut?: boolean;
	interrupted?: boolean;
	exitCode: number | null;
	error?: string;
}): RelayExposureNormalCloseReason {
	if (run.timedOut) return "timeout";
	if (run.interrupted) return "interrupted";
	return run.exitCode === 0 && !run.error ? "completed" : "controlled_shutdown";
}

export interface RelayRunnerLeaseController {
	close(reason: RelayExposureNormalCloseReason): Promise<RelayRunnerLifecycleResult | { ok: true; state: "idempotent" }>;
	snapshot(): { lease?: RelayExposureLeaseMetadata; closed: boolean };
}

export function createRelayRunnerLeaseController(
	client: RelayRunnerClient,
	initialLease: RelayExposureLeaseMetadata,
	options: { ttlMs: number },
): RelayRunnerLeaseController {
	let lease: RelayExposureLeaseMetadata | undefined = cloneLease(initialLease);
	let closed = false;
	let timer: NodeJS.Timeout | undefined;
	let retryTimer: NodeJS.Timeout | undefined;
	let tail: Promise<void> = Promise.resolve();
	let closeResult: Promise<RelayRunnerLifecycleResult | { ok: true; state: "idempotent" }> | undefined;

	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation, operation);
		tail = result.then(() => undefined, () => undefined);
		return result;
	};
	const clearTimers = () => {
		if (timer) clearTimeout(timer);
		if (retryTimer) clearTimeout(retryTimer);
		timer = undefined;
		retryTimer = undefined;
	};
	const schedule = () => {
		if (closed || !lease) return;
		if (timer) clearTimeout(timer);
		const revision = cloneLease(lease);
		const delay = Math.max(10, Math.floor((revision.expiresAt - Date.now()) / 2));
		timer = setTimeout(() => {
			timer = undefined;
			attempt(revision, randomUUID(), 0);
		}, delay);
		timer.unref?.();
	};
	const retry = (revision: RelayExposureLeaseMetadata, renewalId: string, retryCount: number) => {
		if (closed || retryTimer || !sameLeaseRevision(lease, revision)) return;
		const remaining = revision.expiresAt - Date.now();
		if (remaining <= 0) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (!closed && Date.now() < revision.expiresAt) attempt(revision, renewalId, retryCount);
		}, Math.max(10, Math.min(250, Math.floor(remaining / 4))));
		retryTimer.unref?.();
	};
	const attempt = (revision: RelayExposureLeaseMetadata, renewalId: string, retryCount: number) => {
		if (closed || Date.now() >= revision.expiresAt || !sameLeaseRevision(lease, revision)) return;
		void enqueue(async () => {
			if (closed || Date.now() >= revision.expiresAt || !sameLeaseRevision(lease, revision)) return;
			let result: RelayRunnerLifecycleResult;
			try {
				result = await client.renew(revision, options.ttlMs, renewalId);
			} catch {
				if (retryCount < 1) retry(revision, renewalId, retryCount + 1);
				return;
			}
			if (result.ok) {
				lease = cloneLease(result.lease);
				if (!closed) schedule();
			} else if (TERMINAL_FAILURES.has(result.reason)) {
				lease = undefined;
				clearTimers();
			} else if (RETRYABLE_FAILURES.has(result.reason) && retryCount < 1) {
				retry(revision, renewalId, retryCount + 1);
			}
		});
	};

	schedule();
	return {
		snapshot: () => ({ ...(lease ? { lease: cloneLease(lease) } : {}), closed }),
		close(reason) {
			if (closeResult) return closeResult;
			closed = true;
			clearTimers();
			closeResult = enqueue(async () => {
				const current = lease;
				if (!current) return { ok: true as const, state: "idempotent" as const };
				const result = await client.close(current, reason);
				if (result.ok || TERMINAL_FAILURES.has(result.reason)) lease = undefined;
				return result;
			});
			return closeResult;
		},
	};
}
