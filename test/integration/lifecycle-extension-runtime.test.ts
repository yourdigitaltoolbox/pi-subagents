import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CoordinatorPublisherV1, DrainerRegistration, ReleasePermit } from "@yourdigitaltoolbox/pi-context-lifecycle";
import { registryForHost } from "@yourdigitaltoolbox/pi-context-lifecycle/testing";
import registerSubagentExtension from "../../src/extension/index.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	type ControlEvent,
} from "../../src/shared/types.ts";

const SESSION_ID = "managed-session";
const GENERATION_A = "managed-generation-a";
const GENERATION_B = "managed-generation-b";

interface SentMessage {
	message: { customType?: string; content?: string };
	options: { triggerTurn?: boolean } | undefined;
}

interface ManagedRuntime {
	events: EventEmitter;
	sent: SentMessage[];
	registrations: DrainerRegistration[];
	setGeneration(generationId: string): void;
	setPhase(phase: "compacting" | "idle"): void;
	dispose(): void;
}

function releasePermit(laneId: ReleasePermit["laneId"], generationId: string, cut: { watermark: number; heldCount: number }): ReleasePermit {
	return Object.freeze({
		protocolVersion: 1,
		sessionId: SESSION_ID,
		generationId,
		operationId: "managed-operation",
		releaseId: `release-${laneId}-${generationId}`,
		consumerId: "pi-subagents",
		laneId,
		cut: Object.freeze(cut),
	});
}

function createManagedRuntime(): ManagedRuntime {
	const registry = registryForHost(globalThis);
	assert.equal(registry.snapshot().registryState, "unavailable", "test must not inherit a lifecycle owner");
	let generationId = GENERATION_A;
	let phase: "compacting" | "idle" = "compacting";
	const registrations: DrainerRegistration[] = [];
	const publisher: CoordinatorPublisherV1 = {
		protocolVersion: 1,
		requestCompaction: () => ({ disposition: "rejected", code: "not-needed", generationId }),
		admitWake(request, permit) {
			if (request.sessionId !== SESSION_ID || request.generationId !== generationId) {
				return { disposition: "reject", code: "generation-mismatch", generationId };
			}
			if (!permit && phase === "compacting") return { disposition: "hold", code: "compacting", generationId, operationId: "managed-operation", phase };
			if (permit && permit.generationId !== generationId) return { disposition: "reject", code: "stale-permit", generationId };
			return { disposition: "deliver", code: "release", generationId, operationId: "managed-operation", phase: "releasing" };
		},
		registerDrainer(registration) {
			registrations.push(registration);
			return () => {
				const index = registrations.indexOf(registration);
				if (index >= 0) registrations.splice(index, 1);
			};
		},
		repair: () => ({ disposition: "rejected", code: "not-needed", generationId, sequence: 0 }),
		diagnostics: () => [],
	};
	const publication = registry.publish("lifecycle-extension-runtime-test", publisher, {
		sessionId: SESSION_ID,
		generationId,
		phase,
		operationId: "managed-operation",
	});
	const events = new EventEmitter();
	const sent: SentMessage[] = [];
	const pi = new Proxy({
		events,
		on(event: string, handler: (...args: unknown[]) => void) {
			events.on(event, handler);
			return () => events.off(event, handler);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
			sent.push({ message, options });
		},
		getSessionName() { return undefined; },
	}, {
		get(target, property) {
			if (property in target) return target[property as keyof typeof target];
			return () => undefined;
		},
	});
	registerSubagentExtension(pi as never);
	const context = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			requestRender() {},
			setWidget() {},
			setToolsExpanded() {},
			theme: { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text },
		},
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => null,
			getEntries: () => [],
		},
		modelRegistry: { getAvailable: () => [] },
	};
	events.emit("session_start", { reason: "startup" }, context);
	return {
		events,
		sent,
		registrations,
		setGeneration(nextGenerationId: string) {
			generationId = nextGenerationId;
			phase = "compacting";
			publication.update({
				sessionId: SESSION_ID,
				generationId,
				phase,
				operationId: "managed-operation",
			});
		},
		setPhase(nextPhase: "compacting" | "idle") {
			phase = nextPhase;
			publication.update({
				sessionId: SESSION_ID,
				generationId,
				phase,
				operationId: "managed-operation",
			});
		},
		dispose() {
			events.emit("session_shutdown", { reason: "quit" }, context);
			publication.dispose();
		},
	};
}

function completion(id: string) {
	return {
		id,
		agent: "worker",
		success: true,
		summary: `${id} complete`,
		exitCode: 0,
		timestamp: 1,
		sessionId: SESSION_ID,
	};
}

function attention(): { source: "async"; event: ControlEvent } {
	return {
		source: "async",
		event: {
			type: "needs_attention",
			to: "needs_attention",
			ts: 1,
			runId: "attention-run",
			agent: "worker",
			index: 0,
			message: "worker needs attention",
			reason: "idle",
		},
	};
}

const priorLifecycleMode = process.env.PI_SUBAGENTS_CONTEXT_LIFECYCLE_MODE;
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
let configRoot: string | undefined;

function prepareManagedMode(): void {
	delete process.env.PI_SUBAGENTS_CONTEXT_LIFECYCLE_MODE;
	configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-lifecycle-extension-test-"));
	process.env.PI_CODING_AGENT_DIR = configRoot;
	const configDir = path.join(configRoot, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ completionBatch: { enabled: false } }));
}

afterEach(() => {
	if (priorLifecycleMode === undefined) delete process.env.PI_SUBAGENTS_CONTEXT_LIFECYCLE_MODE;
	else process.env.PI_SUBAGENTS_CONTEXT_LIFECYCLE_MODE = priorLifecycleMode;
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	if (configRoot) fs.rmSync(configRoot, { recursive: true, force: true });
	configRoot = undefined;
});

describe("subagent extension managed lifecycle integration", () => {
	it("holds parent turns until the failure-attention lane drains before success", () => {
		prepareManagedMode();
		const runtime = createManagedRuntime();
		try {
			runtime.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("success-held"));
			runtime.events.emit(SUBAGENT_CONTROL_EVENT, attention());
			assert.deepEqual(runtime.sent, []);

			const failure = runtime.registrations.find((registration) => registration.laneId === "failure-attention-decision");
			const success = runtime.registrations.find((registration) => registration.laneId === "subagent-success");
			assert.ok(failure, "failure/attention lane must register");
			assert.ok(success, "success lane must register");

			const failureCut = failure.capture();
			const failureAck = failure.drain(releasePermit("failure-attention-decision", GENERATION_A, failureCut));
			assert.equal(failureAck.disposition, "submitted");
			assert.equal(runtime.sent.length, 1);
			assert.equal(runtime.sent[0]?.message.customType, "subagent_control_notice");
			assert.deepEqual(runtime.sent[0]?.options, { triggerTurn: true });

			const successCut = success.capture();
			const successAck = success.drain(releasePermit("subagent-success", GENERATION_A, successCut));
			assert.equal(successAck.disposition, "submitted");
			assert.equal(runtime.sent.length, 2);
			assert.equal(runtime.sent[1]?.message.customType, "subagent-notify");
			assert.deepEqual(runtime.sent[1]?.options, { triggerTurn: true });
		} finally {
			runtime.dispose();
		}
	});

	it("keeps post-cut success work held until the lifecycle returns to idle", () => {
		prepareManagedMode();
		const runtime = createManagedRuntime();
		try {
			runtime.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("captured"));
			const success = runtime.registrations.find((registration) => registration.laneId === "subagent-success");
			assert.ok(success);
			const cut = success.capture();
			runtime.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("post-cut"));

			const acknowledgement = success.drain(releasePermit("subagent-success", GENERATION_A, cut));
			assert.equal(acknowledgement.disposition, "submitted");
			assert.equal(runtime.sent.length, 1);
			assert.match(runtime.sent[0]?.message.content ?? "", /captured complete/);
			assert.doesNotMatch(runtime.sent[0]?.message.content ?? "", /post-cut complete/);

			runtime.setPhase("idle");
			assert.equal(runtime.sent.length, 2);
			assert.match(runtime.sent[1]?.message.content ?? "", /post-cut complete/);
		} finally {
			runtime.dispose();
		}
	});

	it("rejects a stale-generation release permit without starting a parent turn", () => {
		prepareManagedMode();
		const runtime = createManagedRuntime();
		try {
			runtime.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("stale-held"));
			const staleRegistration = runtime.registrations.find((registration) => registration.laneId === "subagent-success");
			assert.ok(staleRegistration);
			const cut = staleRegistration.capture();

			runtime.setGeneration(GENERATION_B);
			const acknowledgement = staleRegistration.drain(releasePermit("subagent-success", GENERATION_A, cut));
			assert.equal(acknowledgement.disposition, "blocked");
			assert.deepEqual(runtime.sent, []);
		} finally {
			runtime.dispose();
		}
	});
});
