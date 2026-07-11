import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	closeRelayExposureLease,
	delegateRelayRunner,
	explicitExtensionSelectionLoadsRemotePi,
	promoteRelayExposureLease,
	renewRelayExposureLease,
	requestRelayExposureLease,
	revokeRelayExposureLease,
	RELAY_EXPOSURE_REQUEST_EVENT,
	relayExposureReplyEvent,
	type RelayExposureEventBus,
	type RelayExposureLeaseMetadata,
} from "../../src/runs/shared/relay-exposure.ts";

const BINDING = {
	runId: "run-1",
	workspaceId: "11111111-1111-4111-8111-111111111111",
	agentId: "22222222-2222-4222-8222-222222222222",
	processEpoch: "33333333-3333-4333-8333-333333333333",
	mode: "relay" as const,
};

class Events implements RelayExposureEventBus {
	private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

	on(channel: string, handler: (value: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(value: unknown) => void>();
		set.add(handler);
		this.handlers.set(channel, set);
		return () => set.delete(handler);
	}

	emit(channel: string, value: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(value);
	}
}

describe("relay exposure parent RPC", () => {
	it("recognizes remote-pi only when an explicit extension allowlist actually selects it", () => {
		assert.equal(explicitExtensionSelectionLoadsRemotePi(undefined), true);
		assert.equal(explicitExtensionSelectionLoadsRemotePi([]), false);
		assert.equal(explicitExtensionSelectionLoadsRemotePi(["./allowed-ext.ts"]), false);
		assert.equal(explicitExtensionSelectionLoadsRemotePi(["npm:remote-pi@0.5.4"]), true);
		assert.equal(explicitExtensionSelectionLoadsRemotePi(["/opt/node_modules/remote-pi/dist/index.js"]), true);
		assert.equal(explicitExtensionSelectionLoadsRemotePi(["/workspace/remote_pi/pi-extension/src/index.ts"]), true);
	});

	it("delegates a bounded async runner token and broker socket only through the parent event call stack", async () => {
		const events = new Events();
		const now = Date.now();
		let observed: Record<string, unknown> | undefined;
		events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			observed = raw as Record<string, unknown>;
			const request = raw as { requestId: string };
			events.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: true,
				ok: true,
				token: `rprd1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`,
				socketPath: "/tmp/remote-pi-broker.sock",
				expiresAt: now + 60_000,
				maxLeaseTtlMs: 30_000,
				maxChildIssues: 4,
			});
		});

		const result = await delegateRelayRunner(events, {
			rootRunId: "run-async",
			workspaceId: BINDING.workspaceId,
			delegationTtlMs: 60_000,
			maxLeaseTtlMs: 30_000,
			maxChildIssues: 4,
			timeoutMs: 50,
			now: () => now,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.match(result.token, /^rprd1\./);
		assert.equal(result.socketPath, "/tmp/remote-pi-broker.sock");
		assert.deepEqual(observed && {
			method: observed.method,
			rootRunId: observed.rootRunId,
			workspaceId: observed.workspaceId,
			delegationTtlMs: observed.delegationTtlMs,
			maxLeaseTtlMs: observed.maxLeaseTtlMs,
			maxChildIssues: observed.maxChildIssues,
			hasCapability: "capability" in observed,
		}, {
			method: "delegate_runner",
			rootRunId: "run-async",
			workspaceId: BINDING.workspaceId,
			delegationTtlMs: 60_000,
			maxLeaseTtlMs: 30_000,
			maxChildIssues: 4,
			hasCapability: false,
		});
	});

	it("rejects runner delegation response schema drift and authority-looking fields", async () => {
		const now = Date.now();
		for (const override of [{ workloadId: "forged" }, { capability: "forged" }, { socketPath: "" }]) {
			const events = new Events();
			events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
				const request = raw as { requestId: string };
				events.emit(relayExposureReplyEvent(request.requestId), {
					version: 1,
					requestId: request.requestId,
					success: true,
					ok: true,
					token: `rprd1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`,
					socketPath: "/tmp/remote-pi-broker.sock",
					expiresAt: now + 60_000,
					maxLeaseTtlMs: 30_000,
					maxChildIssues: 4,
					...override,
				});
			});
			assert.deepEqual(await delegateRelayRunner(events, {
				rootRunId: "run-async",
				workspaceId: BINDING.workspaceId,
				delegationTtlMs: 60_000,
				maxLeaseTtlMs: 30_000,
				maxChildIssues: 4,
				timeoutMs: 50,
				now: () => now,
			}), { ok: false, reason: "invalid_reply" });
		}
	});

	it("requests one process-bound capability and returns only validated issuance data", async () => {
		const events = new Events();
		const issuedAt = Date.now();
		events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string };
			events.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: true,
				ok: true,
				capability: `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`,
				lease: {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					binding: BINDING,
					issuedAt,
					expiresAt: issuedAt + 30_000,
					parent: {
						workspaceId: BINDING.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
				},
			});
		});

		const result = await requestRelayExposureLease(events, BINDING, { ttlMs: 30_000, timeoutMs: 50 });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.match(result.capability, /^rpel1\./);
		assert.deepEqual(result.lease.binding, BINDING);
	});

	it("rejects unknown response fields, nested schema drift, and stale leases", async () => {
		const now = Date.now();
		const baseLease = {
			relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
			binding: BINDING,
			issuedAt: now,
			expiresAt: now + 30_000,
			parent: {
				workspaceId: BINDING.workspaceId,
				agentId: "55555555-5555-4555-8555-555555555555",
				processEpoch: "66666666-6666-4666-8666-666666666666",
			},
		};
		const cases = [
			{ extra: true },
			{ lease: { ...baseLease, parent: { ...baseLease.parent, role: "writer" } } },
			{ lease: { ...baseLease, binding: { ...BINDING, workloadId: "forged" } } },
			{ lease: { ...baseLease, issuedAt: now - 30_000, expiresAt: now - 1 } },
		];
		for (const override of cases) {
			const events = new Events();
			events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
				const request = raw as { requestId: string };
				events.emit(relayExposureReplyEvent(request.requestId), {
					version: 1,
					requestId: request.requestId,
					success: true,
					ok: true,
					capability: `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`,
					lease: baseLease,
					...override,
				});
			});
			assert.deepEqual(
				await requestRelayExposureLease(events, BINDING, { ttlMs: 30_000, timeoutMs: 50 }),
				{ ok: false, reason: "invalid_reply" },
			);
		}
	});

	it("promotes one exact live binding without a bearer in either direction", async () => {
		const events = new Events();
		const issuedAt = Date.now();
		let observedRequest: Record<string, unknown> | undefined;
		events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			observedRequest = raw as Record<string, unknown>;
			const request = raw as { requestId: string };
			events.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: true,
				ok: true,
				state: "promoted",
				lease: {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					binding: BINDING,
					issuedAt,
					expiresAt: issuedAt + 30_000,
					parent: {
						workspaceId: BINDING.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
				},
			});
		});

		const result = await promoteRelayExposureLease(events, BINDING, { ttlMs: 30_000, timeoutMs: 50 });
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.state, "promoted");
		assert.deepEqual(observedRequest && {
			method: observedRequest.method,
			binding: observedRequest.binding,
			ttlMs: observedRequest.ttlMs,
			hasCapability: "capability" in observedRequest,
		}, { method: "promote", binding: BINDING, ttlMs: 30_000, hasCapability: false });
		assert.equal(JSON.stringify(result).includes("rpel1."), false);
	});

	it("renews, revokes, and closes only the exact lease with no bearer in lifecycle requests", async () => {
		const now = Date.now();
		let lease: RelayExposureLeaseMetadata = {
			relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
			binding: BINDING,
			issuedAt: now,
			expiresAt: now + 30_000,
			parent: {
				workspaceId: BINDING.workspaceId,
				agentId: "55555555-5555-4555-8555-555555555555",
				processEpoch: "66666666-6666-4666-8666-666666666666",
			},
		};
		const events = new Events();
		const methods: string[] = [];
		events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as Record<string, unknown>;
			methods.push(request.method as string);
			assert.equal("capability" in request, false);
			const method = request.method as "renew" | "revoke" | "close";
			const nextLease = method === "renew" ? { ...lease, expiresAt: now + 60_000 } : lease;
			events.emit(relayExposureReplyEvent(request.requestId as string), {
				version: 1,
				requestId: request.requestId,
				success: true,
				ok: true,
				state: method === "renew" ? "renewed" : method === "revoke" ? "revoked" : "closed",
				lease: nextLease,
			});
		});

		const renewed = await renewRelayExposureLease(events, lease, {
			ttlMs: 60_000,
			renewalId: "77777777-7777-4777-8777-777777777777",
			timeoutMs: 50,
		});
		assert.equal(renewed.ok, true);
		if (renewed.ok) lease = renewed.lease;
		assert.equal(lease.expiresAt, now + 60_000);
		assert.equal((await revokeRelayExposureLease(events, lease, { timeoutMs: 50 })).ok, true);
		assert.equal((await closeRelayExposureLease(events, lease, "timeout", { timeoutMs: 50 })).ok, true);
		assert.deepEqual(methods, ["renew", "revoke", "close"]);
	});

	it("rejects malformed lifecycle replies and preserves binding-mismatch diagnostics", async () => {
		const now = Date.now();
		const lease: RelayExposureLeaseMetadata = {
			relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
			binding: BINDING,
			issuedAt: now,
			expiresAt: now + 30_000,
			parent: {
				workspaceId: BINDING.workspaceId,
				agentId: "55555555-5555-4555-8555-555555555555",
				processEpoch: "66666666-6666-4666-8666-666666666666",
			},
		};
		const mismatch = new Events();
		mismatch.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string };
			mismatch.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: false,
				reason: "binding_mismatch",
				field: "processEpoch",
			});
		});
		assert.deepEqual(
			await revokeRelayExposureLease(mismatch, lease, { timeoutMs: 50 }),
			{ ok: false, reason: "binding_mismatch", field: "processEpoch" },
		);

		const extra = new Events();
		extra.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string };
			extra.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: true,
				ok: true,
				state: "renewed",
				lease: { ...lease, expiresAt: now + 60_000 },
				workloadId: "forged",
			});
		});
		assert.deepEqual(
			await renewRelayExposureLease(extra, lease, {
				ttlMs: 60_000,
				renewalId: "77777777-7777-4777-8777-777777777777",
				timeoutMs: 50,
			}),
			{ ok: false, reason: "invalid_reply" },
		);
	});

	it("ignores wrong-version and wrong-request-id replies", async () => {
		for (const invalidCorrelation of [
			{ version: 2 },
			{ requestId: "77777777-7777-4777-8777-777777777777" },
		]) {
			const events = new Events();
			events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
				const request = raw as { requestId: string };
				events.emit(relayExposureReplyEvent(request.requestId), {
					version: 1,
					requestId: request.requestId,
					success: false,
					reason: "unauthorized_parent",
					...invalidCorrelation,
				});
			});
			assert.deepEqual(
				await requestRelayExposureLease(events, BINDING, { ttlMs: 30_000, timeoutMs: 5 }),
				{ ok: false, reason: "timeout" },
			);
		}
	});

	it("turns event-bus subscription failures into a typed denial", async () => {
		const throwingEvents: RelayExposureEventBus = {
			on: () => { throw new Error("subscription failed"); },
			emit: () => {},
		};
		assert.deepEqual(
			await requestRelayExposureLease(throwingEvents, BINDING, { ttlMs: 30_000, timeoutMs: 5 }),
			{ ok: false, reason: "event_bus_error" },
		);
	});

	it("fails closed on denial, malformed success, and timeout without throwing", async () => {
		const denied = new Events();
		denied.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string };
			denied.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: false,
				reason: "unauthorized_parent",
			});
		});
		assert.deepEqual(
			await requestRelayExposureLease(denied, BINDING, { ttlMs: 30_000, timeoutMs: 50 }),
			{ ok: false, reason: "unauthorized_parent" },
		);

		const unknownDenial = new Events();
		unknownDenial.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string };
			unknownDenial.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: false,
				reason: "writer_lease_granted",
			});
		});
		assert.deepEqual(
			await requestRelayExposureLease(unknownDenial, BINDING, { ttlMs: 30_000, timeoutMs: 50 }),
			{ ok: false, reason: "invalid_reply" },
		);

		const malformed = new Events();
		malformed.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string };
			malformed.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: true,
				capability: "not-a-capability",
			});
		});
		assert.deepEqual(
			await requestRelayExposureLease(malformed, BINDING, { ttlMs: 30_000, timeoutMs: 50 }),
			{ ok: false, reason: "invalid_reply" },
		);

		assert.deepEqual(
			await requestRelayExposureLease(new Events(), BINDING, { ttlMs: 30_000, timeoutMs: 5 }),
			{ ok: false, reason: "timeout" },
		);
	});
});
