import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createForegroundRelayExposureController,
	registerForegroundRelayExposureController,
	resolveForegroundRelayExposureController,
	unregisterForegroundRelayExposureController,
} from "../../src/runs/foreground/relay-exposure-controller.ts";
import {
	RELAY_EXPOSURE_REQUEST_EVENT,
	relayExposureReplyEvent,
	type RelayExposureEventBus,
} from "../../src/runs/shared/relay-exposure.ts";

const BINDING = {
	runId: "run-live-control",
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

function installAuthority(events: Events): { methods: string[]; requests: Array<Record<string, unknown>> } {
	const methods: string[] = [];
	const requests: Array<Record<string, unknown>> = [];
	let lease: Record<string, unknown> | undefined;
	events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
		const request = raw as Record<string, unknown> & { requestId: string; method: string; binding?: Record<string, unknown> };
		methods.push(request.method);
		requests.push(request);
		if (request.method === "promote") {
			const issuedAt = Date.now();
			lease = {
				relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
				parent: {
					workspaceId: BINDING.workspaceId,
					agentId: "55555555-5555-4555-8555-555555555555",
					processEpoch: "66666666-6666-4666-8666-666666666666",
				},
				binding: request.binding,
				issuedAt,
				expiresAt: issuedAt + 30_000,
			};
			events.emit(relayExposureReplyEvent(request.requestId), {
				version: 1, requestId: request.requestId, success: true, ok: true, state: "promoted", lease,
			});
			return;
		}
		if (request.method === "renew") lease = { ...lease!, expiresAt: Date.now() + 30_000 };
		events.emit(relayExposureReplyEvent(request.requestId), {
			version: 1,
			requestId: request.requestId,
			success: true,
			ok: true,
			state: request.method === "renew" ? "renewed" : request.method === "revoke" ? "revoked" : "closed",
			lease,
		});
	});
	return { methods, requests };
}

describe("foreground relay exposure controller", () => {
	it("promotes, renews, and demotes one exact live child without retaining capability material", async () => {
		const events = new Events();
		const authority = installAuthority(events);
		const controller = createForegroundRelayExposureController({
			events,
			binding: BINDING,
			agent: "reviewer",
			index: 2,
			parentSessionId: "parent-session-1",
			defaultTtlMs: 30_000,
		});
		registerForegroundRelayExposureController(controller);
		try {
			assert.equal(resolveForegroundRelayExposureController({
				runId: BINDING.runId,
				index: 2,
				parentSessionId: "parent-session-1",
			}).controller, controller);
			assert.equal(resolveForegroundRelayExposureController({
				runId: BINDING.runId,
				index: 2,
				parentSessionId: "different-parent-session",
			}).controller, undefined);

			const promoted = await controller.relay(30_000);
			assert.equal(promoted.ok, true);
			assert.equal(promoted.ok && promoted.state, "promoted");
			assert.equal(controller.snapshot().lease?.relayExposureLeaseId, "44444444-4444-4444-8444-444444444444");

			const renewed = await controller.relay(30_000);
			assert.equal(renewed.ok, true);
			assert.equal(renewed.ok && renewed.state, "renewed");

			const demoted = await controller.local();
			assert.equal(demoted.ok, true);
			assert.equal(demoted.ok && demoted.state, "revoked");
			assert.equal(controller.snapshot().lease, undefined);
			assert.deepEqual(authority.methods, ["promote", "renew", "revoke"]);
			assert.equal(authority.requests.some((request) => "capability" in request), false);
			assert.equal(JSON.stringify(controller.snapshot()).includes("rpel1."), false);
		} finally {
			unregisterForegroundRelayExposureController(controller);
			await controller.close("controlled_shutdown");
		}
	});

	it("clears broker-lost lease metadata and permits one fresh promotion", async () => {
		const events = new Events();
		const methods: string[] = [];
		let promotions = 0;
		events.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string; method: string; binding: Record<string, unknown> };
			methods.push(request.method);
			if (request.method === "promote") {
				promotions++;
				const issuedAt = Date.now();
				events.emit(relayExposureReplyEvent(request.requestId), {
					version: 1,
					requestId: request.requestId,
					success: true,
					ok: true,
					state: "promoted",
					lease: {
						relayExposureLeaseId: promotions === 1
							? "44444444-4444-4444-8444-444444444444"
							: "77777777-7777-4777-8777-777777777777",
						parent: {
							workspaceId: BINDING.workspaceId,
							agentId: "55555555-5555-4555-8555-555555555555",
							processEpoch: "66666666-6666-4666-8666-666666666666",
						},
						binding: request.binding,
						issuedAt,
						expiresAt: issuedAt + 30_000,
					},
				});
				return;
			}
			events.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: false,
				reason: request.method === "renew" ? "lease_not_found" : "lease_not_active",
			});
		});
		const controller = createForegroundRelayExposureController({
			events, binding: BINDING, agent: "reviewer", index: 0, parentSessionId: "parent", defaultTtlMs: 30_000,
		});

		assert.equal((await controller.relay()).ok, true);
		const recovered = await controller.relay();
		assert.equal(recovered.ok, true);
		assert.equal(recovered.ok && recovered.state, "promoted");
		assert.equal(controller.snapshot().lease?.relayExposureLeaseId, "77777777-7777-4777-8777-777777777777");
		assert.deepEqual(methods, ["promote", "renew", "promote"]);

		const local = await controller.local();
		assert.deepEqual(local, { ok: true, state: "idempotent" });
		assert.equal(controller.snapshot().lease, undefined);
		assert.deepEqual(methods, ["promote", "renew", "promote", "revoke"]);
	});

	it("resolves only one authoritative live controller and unregisters by object identity", () => {
		const first = createForegroundRelayExposureController({
			events: new Events(), binding: BINDING, agent: "a", index: 0, parentSessionId: "parent", defaultTtlMs: 30_000,
		});
		const second = createForegroundRelayExposureController({
			events: new Events(), binding: { ...BINDING, agentId: "77777777-7777-4777-8777-777777777777" }, agent: "b", index: 1, parentSessionId: "parent", defaultTtlMs: 30_000,
		});
		registerForegroundRelayExposureController(first);
		registerForegroundRelayExposureController(second);
		try {
			const ambiguous = resolveForegroundRelayExposureController({ runId: "run-live", parentSessionId: "parent" });
			assert.match(ambiguous.error ?? "", /multiple/i);
			const wrongSession = resolveForegroundRelayExposureController({ runId: BINDING.runId, index: 0, parentSessionId: "other-parent" });
			assert.equal(wrongSession.controller, undefined);
			assert.match(wrongSession.error ?? "", /different parent session/i);
			const missing = resolveForegroundRelayExposureController({ runId: "missing-run", parentSessionId: "parent" });
			assert.equal(missing.controller, undefined);
			assert.match(missing.error ?? "", /no live foreground/i);
			const absentSession = createForegroundRelayExposureController({
				events: new Events(), binding: { ...BINDING, runId: "sessionless" }, agent: "sessionless", index: 3, defaultTtlMs: 30_000,
			});
			registerForegroundRelayExposureController(absentSession);
			try {
				const unresolved = resolveForegroundRelayExposureController({ runId: "sessionless" });
				assert.equal(unresolved.controller, undefined);
				assert.match(unresolved.error ?? "", /parent session/i);
			} finally {
				unregisterForegroundRelayExposureController(absentSession);
			}
			unregisterForegroundRelayExposureController(first);
			assert.equal(resolveForegroundRelayExposureController({ runId: BINDING.runId, index: 1, parentSessionId: "parent" }).controller, second);
			unregisterForegroundRelayExposureController(first);
			assert.equal(resolveForegroundRelayExposureController({ runId: BINDING.runId, index: 1, parentSessionId: "parent" }).controller, second);
		} finally {
			unregisterForegroundRelayExposureController(first);
			unregisterForegroundRelayExposureController(second);
		}
	});
});
