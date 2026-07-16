import assert from "node:assert/strict";
import test from "node:test";
import { registryForHost } from "@yourdigitaltoolbox/pi-context-lifecycle/testing";
import { createExactCandidateProbe } from "pi-subagents/testing";

const SESSION_ID = "exact-candidate-session";
const GENERATION_ID = "exact-candidate-generation";
const OPERATION_ID = "exact-candidate-operation";

test("archive testing probe records dispatch order when failure-success delivery promises settle inversely", async () => {
	const registry = registryForHost(globalThis);
	assert.equal(registry.snapshot().registryState, "unavailable", "test must not inherit a lifecycle owner");
	let phase: "compacting" | "idle" = "compacting";
	const registrations: Array<{ laneId: string; capture(): { watermark: number; heldCount: number }; drain(permit: never): { disposition: string } }> = [];
	const publication = registry.publish("exact-candidate-probe-test", {
		protocolVersion: 1,
		requestCompaction: () => ({ disposition: "rejected", code: "not-needed", generationId: GENERATION_ID }),
		admitWake(_request, permit) {
			if (!permit && phase === "compacting") return { disposition: "hold", code: "compacting", generationId: GENERATION_ID, operationId: OPERATION_ID, phase };
			return { disposition: "deliver", code: "released", generationId: GENERATION_ID, operationId: OPERATION_ID, phase: "releasing" };
		},
		registerDrainer(registration) {
			registrations.push(registration as never);
			return () => {
				const index = registrations.indexOf(registration as never);
				if (index >= 0) registrations.splice(index, 1);
			};
		},
		repair: () => ({ disposition: "rejected", code: "not-needed", generationId: GENERATION_ID, sequence: 0 }),
		diagnostics: () => [],
	}, {
		sessionId: SESSION_ID,
		generationId: GENERATION_ID,
		phase,
		operationId: OPERATION_ID,
	});
	const sent: unknown[] = [];
	const pendingSends: Array<{ resolve(): void }> = [];
	const session = {
		sessionId: SESSION_ID,
		sendCustomMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
			return new Promise<void>((resolve) => pendingSends.push({ resolve }));
		},
	};
	const probe = createExactCandidateProbe({ session: session as never, seed: 6607, packageDirectory: process.cwd() });
	try {
		assert.equal(Object.isFrozen(probe), true);
		assert.equal(probe.consumer, "pi-subagents");
		assert.deepEqual(await probe.inject({ consumer: "pi-subagents", kind: "completion", id: "success-1", outcome: "success" }), {
			consumer: "pi-subagents",
			id: "success-1",
			outcome: "held",
			laneId: "subagent-success",
			operationId: OPERATION_ID,
			generationId: GENERATION_ID,
			notificationCount: 0,
		});
		assert.deepEqual(await probe.inject({ consumer: "pi-subagents", kind: "completion", id: "failure-1", outcome: "failure" }), {
			consumer: "pi-subagents",
			id: "failure-1",
			outcome: "held",
			laneId: "failure-attention-decision",
			operationId: OPERATION_ID,
			generationId: GENERATION_ID,
			notificationCount: 0,
		});
		assert.equal(sent.length, 0);

		for (const laneId of ["failure-attention-decision", "subagent-success"]) {
			const registration = registrations.find((candidate) => candidate.laneId === laneId);
			assert.ok(registration, `${laneId} must register with lifecycle authority`);
			const cut = registration.capture();
			const acknowledgement = registration.drain({
				protocolVersion: 1,
				sessionId: SESSION_ID,
				generationId: GENERATION_ID,
				operationId: OPERATION_ID,
				releaseId: `release-${laneId}`,
				consumerId: "pi-subagents",
				laneId,
				cut,
			} as never);
			assert.equal(acknowledgement.disposition, "submitted");
		}
		assert.equal(sent.length, 2);
		assert.equal(pendingSends.length, 2);
		// Failure dispatches first, but its promise settles after success.
		pendingSends[1]!.resolve();
		pendingSends[0]!.resolve();
		const observations = await probe.observations();
		assert.equal(Object.isFrozen(observations), true);
		assert.deepEqual(observations.map((receipt) => [receipt.id, receipt.outcome, receipt.laneId, receipt.notificationCount, receipt.dispatchSequence]), [
			["success-1", "held", "subagent-success", 0, undefined],
			["failure-1", "held", "failure-attention-decision", 0, undefined],
			["success-1", "released", "subagent-success", 1, 2],
			["failure-1", "released", "failure-attention-decision", 1, 1],
		]);
		assert.deepEqual(
			observations.filter((receipt) => receipt.outcome === "released").toSorted((left, right) => left.dispatchSequence! - right.dispatchSequence!).map((receipt) => receipt.id),
			["failure-1", "success-1"],
		);
		assert.deepEqual(sent.map((entry) => entry as { message: { content?: string }; options: unknown }), [
			{ message: { customType: "subagent-notify", content: "Background task failed: **subagent**\n\nSubagent completion notification", display: true }, options: { triggerTurn: true } },
			{ message: { customType: "subagent-notify", content: "Background task completed: **subagent**\n\nSubagent completion notification", display: true }, options: { triggerTurn: true } },
		]);
		await assert.rejects(probe.inject({ consumer: "pi-subagents", kind: "completion", id: "bad", outcome: "paused" } as never), /completion injections only/);
	} finally {
		await probe.dispose();
		publication.dispose();
	}
});
