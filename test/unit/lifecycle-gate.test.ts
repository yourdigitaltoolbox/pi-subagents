import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DrainAck, DrainerRegistration, LifecycleEvent, ReleasePermit, Snapshot, WakeAdmission } from "@yourdigitaltoolbox/pi-context-lifecycle";
import { LifecycleGate, MAX_HELD_COMPLETION_KEYS, type LifecycleGateAuthority } from "../../src/runs/background/lifecycle-gate.ts";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		protocolVersion: 1,
		registryState: "ready",
		sequence: 1,
		sessionId: "session",
		generationId: "generation-1",
		phase: "idle",
		...overrides,
	};
}

function permit(cut: { watermark: number; heldCount: number }, generationId = "generation-1"): ReleasePermit {
	return Object.freeze({
		protocolVersion: 1,
		sessionId: "session",
		generationId,
		operationId: "operation",
		releaseId: "release",
		consumerId: "pi-subagents",
		laneId: "subagent-success",
		cut: Object.freeze(cut),
	});
}

function createAuthority(initial: Snapshot, admit: (request: WakeAdmission, permit?: ReleasePermit) => "deliver" | "hold" | "reject") {
	let current = initial;
	const listeners = new Set<(event: LifecycleEvent) => void>();
	const registrations: DrainerRegistration[] = [];
	const authority: LifecycleGateAuthority = {
		snapshot: () => current,
		observe(listener) {
			listeners.add(listener);
			return { snapshot: current, unsubscribe: () => listeners.delete(listener) };
		},
		admitWake(request, releasePermit) {
			return { disposition: admit(request, releasePermit), code: "test" };
		},
		registerDrainer(registration) {
			registrations.push(registration);
			return () => {
				const index = registrations.indexOf(registration);
				if (index >= 0) registrations.splice(index, 1);
			};
		},
	};
	return {
		authority,
		registrations,
		setSnapshot(next: Snapshot) {
			current = next;
			for (const listener of listeners) listener({ ...next, event: "snapshot" });
		},
	};
}

describe("LifecycleGate", () => {
	it("fails closed in managed mode when lifecycle authority is absent", () => {
		const test = createAuthority(snapshot({ registryState: "unavailable", sessionId: undefined, generationId: undefined, phase: undefined }), () => "reject");
		const blocked: string[] = [];
		const emitted: string[] = [];
		const gate = new LifecycleGate({
			laneId: "subagent-success",
			mode: "managed",
			getSessionId: () => "session",
			emit: ({ items }) => emitted.push(...items),
			onBlocked: (code) => blocked.push(code),
			authority: test.authority,
		});

		assert.equal(gate.receive("completion-1", "done"), "blocked");
		assert.deepEqual(emitted, []);
		assert.deepEqual(blocked, ["lifecycle-authority-unavailable"]);
		gate.dispose();
	});

	it("allows explicit compatibility mode when lifecycle authority is absent", () => {
		const test = createAuthority(snapshot({ registryState: "unavailable", sessionId: undefined, generationId: undefined, phase: undefined }), () => "reject");
		const emitted: string[] = [];
		const gate = new LifecycleGate({
			laneId: "subagent-success",
			mode: "compatibility",
			getSessionId: () => "session",
			emit: ({ items }) => emitted.push(...items),
			authority: test.authority,
		});

		assert.equal(gate.receive("completion-1", "done"), "delivered");
		assert.deepEqual(emitted, ["done"]);
		gate.dispose();
	});

	it("captures exactly 256 held completion keys plus one bounded rollup and drains under its permit", () => {
		const test = createAuthority(snapshot({ phase: "compacting" }), (_request, releasePermit) => releasePermit ? "deliver" : "hold");
		const emitted: Array<{ items: readonly number[]; overflowCount: number }> = [];
		const gate = new LifecycleGate({
			laneId: "subagent-success",
			mode: "managed",
			getSessionId: () => "session",
			emit: (batch) => emitted.push(batch),
			authority: test.authority,
		});
		assert.equal(test.registrations.length, 1);
		for (let index = 0; index <= MAX_HELD_COMPLETION_KEYS; index++) {
			assert.equal(gate.receive(`completion-${index}`, index), "held");
		}
		const registration = test.registrations[0]!;
		const cut = registration.capture();
		assert.deepEqual(cut, { watermark: MAX_HELD_COMPLETION_KEYS + 1, heldCount: MAX_HELD_COMPLETION_KEYS + 1 });
		const ack = registration.drain(permit(cut)) as DrainAck;
		assert.deepEqual(ack, {
			releaseId: "release",
			consumerId: "pi-subagents",
			laneId: "subagent-success",
			disposition: "submitted",
			submittedCount: 1,
			handledCount: MAX_HELD_COMPLETION_KEYS + 1,
			handledThrough: MAX_HELD_COMPLETION_KEYS + 1,
		});
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0]!.items.length, MAX_HELD_COMPLETION_KEYS);
		assert.equal(emitted[0]!.overflowCount, 1);
		gate.dispose();
	});

	it("does not extend a captured release cut with post-cut work", () => {
		const test = createAuthority(snapshot({ phase: "compacting" }), (request, releasePermit) => releasePermit || request.wakeId.startsWith("idle:") ? "deliver" : "hold");
		const emitted: Array<{ items: readonly string[]; overflowCount: number }> = [];
		const gate = new LifecycleGate({
			laneId: "subagent-success",
			mode: "managed",
			getSessionId: () => "session",
			emit: (batch) => emitted.push(batch),
			authority: test.authority,
		});
		gate.receive("first", "first");
		const registration = test.registrations[0]!;
		const cut = registration.capture();
		gate.receive("post-cut", "post-cut");
		const ack = registration.drain(permit(cut)) as DrainAck;
		assert.equal(ack.handledCount, 1);
		assert.deepEqual(emitted, [{ items: ["first"], overflowCount: 0 }]);

		test.setSnapshot(snapshot({ phase: "idle", sequence: 2 }));
		assert.deepEqual(emitted, [{ items: ["first"], overflowCount: 0 }, { items: ["post-cut"], overflowCount: 0 }]);
		gate.dispose();
	});

	it("returns a blocked acknowledgement when the permit cannot admit the lane", () => {
		const test = createAuthority(snapshot({ phase: "compacting" }), () => "hold");
		const gate = new LifecycleGate({
			laneId: "subagent-success",
			mode: "managed",
			getSessionId: () => "session",
			emit: () => assert.fail("must not emit"),
			authority: test.authority,
		});
		gate.receive("one", "one");
		const registration = test.registrations[0]!;
		const cut = registration.capture();
		const ack = registration.drain(permit(cut)) as DrainAck;
		assert.equal(ack.disposition, "blocked");
		assert.equal(ack.handledCount, 0);
		gate.dispose();
	});
});
