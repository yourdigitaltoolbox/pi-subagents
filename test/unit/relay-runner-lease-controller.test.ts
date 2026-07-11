import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRelayRunnerLeaseController, relayCloseReasonForAsyncRun } from "../../src/runs/background/relay-runner-lease-controller.ts";
import type { RelayRunnerClient, RelayRunnerLifecycleResult } from "../../src/runs/background/relay-runner-client.ts";

const binding = {
	runId: "run-async",
	workspaceId: "11111111-1111-4111-8111-111111111111",
	agentId: "22222222-2222-4222-8222-222222222222",
	processEpoch: "33333333-3333-4333-8333-333333333333",
	mode: "relay" as const,
};

function lease(expiresAt: number) {
	return {
		relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
		parent: {
			workspaceId: binding.workspaceId,
			agentId: "55555555-5555-4555-8555-555555555555",
			processEpoch: "66666666-6666-4666-8666-666666666666",
		},
		binding,
		issuedAt: Date.now() - 1,
		expiresAt,
	};
}

describe("async relay runner lease controller", () => {
	it("maps async process outcomes to the exact typed transport close reason", () => {
		assert.equal(relayCloseReasonForAsyncRun({ exitCode: 0 }), "completed");
		assert.equal(relayCloseReasonForAsyncRun({ exitCode: 1 }), "controlled_shutdown");
		assert.equal(relayCloseReasonForAsyncRun({ exitCode: 0, error: "spawn failed" }), "controlled_shutdown");
		assert.equal(relayCloseReasonForAsyncRun({ exitCode: 1, interrupted: true }), "interrupted");
		assert.equal(relayCloseReasonForAsyncRun({ exitCode: 1, interrupted: true, timedOut: true }), "timeout");
	});

	it("serializes in-flight renewal before close and never rearms after close", async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		const initial = lease(Date.now() + 30);
		let resolveRenew!: (value: RelayRunnerLifecycleResult) => void;
		const renewCalls: string[] = [];
		const closeExpiries: number[] = [];
		const client = {
			issue: async () => ({ ok: false as const, reason: "unused" }),
			renew: async (_lease, _ttl, renewalId) => {
				renewCalls.push(renewalId ?? "");
				return new Promise<RelayRunnerLifecycleResult>((resolve) => { resolveRenew = resolve; });
			},
			revoke: async () => ({ ok: false as const, reason: "unused" }),
			close: async (current) => {
				closeExpiries.push(current.expiresAt);
				return { ok: true as const, state: "closed" as const, lease: current };
			},
			release: async () => ({ ok: true as const, state: "released" as const }),
		} satisfies RelayRunnerClient;
		const controller = createRelayRunnerLeaseController(client, initial, { ttlMs: 60 });
		context.mock.timers.tick(20);
		await Promise.resolve();
		assert.equal(renewCalls.length, 1);
		const closing = controller.close("completed");
		const renewed = { ...initial, expiresAt: Date.now() + 80 };
		resolveRenew({ ok: true, state: "renewed", lease: renewed });
		assert.equal((await closing).ok, true);
		assert.deepEqual(closeExpiries, [renewed.expiresAt]);
		context.mock.timers.tick(50);
		await Promise.resolve();
		assert.equal(renewCalls.length, 1);
		assert.deepEqual(controller.snapshot(), { closed: true });
	});

	it("stops renewal after authoritative stale-token failure", async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		const initial = lease(Date.now() + 30);
		let renews = 0;
		const client = {
			issue: async () => ({ ok: false as const, reason: "unused" }),
			renew: async () => { renews++; return { ok: false as const, reason: "invalid_runner_delegation" }; },
			revoke: async () => ({ ok: false as const, reason: "unused" }),
			close: async () => ({ ok: false as const, reason: "unused" }),
			release: async () => ({ ok: true as const, state: "released" as const }),
		} satisfies RelayRunnerClient;
		const controller = createRelayRunnerLeaseController(client, initial, { ttlMs: 60 });
		context.mock.timers.tick(20);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(renews, 1);
		assert.deepEqual(controller.snapshot(), { closed: false });
	});
});
