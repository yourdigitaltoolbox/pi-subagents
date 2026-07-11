/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses the local createMockPi() helper to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
	tryImport,
} from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../src/shared/types.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../../src/watchdog/child-status.ts";
import { CHILD_SESSION_DESCRIPTOR_ENV } from "../../src/runs/shared/child-session-contract.ts";
import {
	RELAY_EXPOSURE_CAPABILITY_ENV,
	RELAY_EXPOSURE_REQUEST_EVENT,
	relayExposureReplyEvent,
	type RelayExposureEventBus,
} from "../../src/runs/shared/relay-exposure.ts";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

interface ModelAttempt {
	success?: boolean;
	exitCode?: number;
	error?: string;
}

interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	activityState?: string;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	durationMs: number;
	toolCount: number;
}

interface ArtifactPaths {
	outputPath: string;
	transcriptPath?: string;
	metadataPath?: string;
}

interface RunSyncResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	error?: string;
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	usage: { turns: number; input: number; output: number };
	progress: ProgressSummary;
	controlEvents?: Array<{ type?: string; message: string; reason?: string; turns?: number; tokens?: number; currentPath?: string; recentFailureSummary?: string }>;
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	finalOutput?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	detached?: boolean;
	detachedReason?: string;
	savedOutputPath?: string;
	outputMode?: "inline" | "file-only";
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	sessionFile?: string;
	acceptance?: {
		status?: string;
		verifyRuns?: Array<{ status?: string }>;
		runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
	};
}

interface MockPiCallRecord {
	args?: string[];
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
}

function writeWatchdogSettings(projectDir: string, tailMs = 120_000): void {
	const settingsPath = path.join(projectDir, ".pi", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify({
		subagents: {
			watchdog: {
				enabled: true,
				children: {
					enabled: true,
					watchdogTailTimeoutMs: tailMs,
				},
			},
		},
	}, null, 2), "utf-8");
}

async function withIsolatedWatchdogSettings<T>(projectDir: string, run: () => Promise<T>): Promise<T> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const isolatedHome = path.join(projectDir, "isolated-home");
	process.env.PI_CODING_AGENT_DIR = path.join(isolatedHome, ".pi", "agent");
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	try {
		return await run();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
	}
}

function childWatchdogStatus(phase: "idle" | "reviewing" | "autofollow" | "settling" | "stale" | "failed", seq: number, followUpPending = false) {
	return {
		type: CHILD_WATCHDOG_STATUS_EVENT,
		runId: "watchdog-child-run",
		agent: "echo",
		childIndex: 0,
		stepIndex: 0,
		seq,
		phase,
		ts: Date.now() + seq,
		followUpPending,
	};
}

function mockAssistantMessage(text: string, stopReason: "stop" | "tool_use" = "stop") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: stopReason === "tool_use"
				? [{ type: "text", text }, { type: "toolCall", name: "bash", arguments: { command: "echo test" } }]
				: [{ type: "text", text }],
			model: "mock/test-model",
			stopReason,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	};
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
}

interface ExecutorToolResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		asyncId?: string;
		timeoutMs?: number;
		turnBudget?: { maxTurns: number; graceTurns: number };
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
	};
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function readCall(): { args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> } {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
	}

	function readCallArgs(): string[] {
		return readCall().args;
	}

	function makeExecutor(
		agents = [makeAgent("echo")],
		config: Record<string, unknown> = {},
		asyncByDefault = false,
		eventBus: RelayExposureEventBus = createEventBus(),
	) {
		return createSubagentExecutor!({
			pi: { events: eventBus, getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config,
			asyncByDefault,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("treats action='single' with execution fields as single execution", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single alias finished" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-alias",
			{ action: "single", agent: "echo", task: "Run through alias" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /single alias finished/);
	});

	it("rejects unknown action strings at runtime", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"unknown-action",
			{ action: "not-a-real-action" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown action: not-a-real-action/);
		assert.match(result.content[0]?.text ?? "", /Valid:/);
	});

	it("routes watchdog.configure through the management action path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const gpt = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
		const opus = { provider: "anthropic", id: "claude-opus-4-8", reasoning: true };
		const models = [gpt, opus];
		const watchdog = new MainWatchdogRuntime({ cwd: tempDir });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			watchdog,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
		});
		const ctx = {
			...makeMinimalCtx(tempDir),
			model: gpt,
			modelRegistry: {
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: (model: unknown) => Boolean(model),
			},
		};

		const result = await executor.execute(
			"watchdog-configure",
			{ action: "watchdog.configure", model: "recommended" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /session model configured: anthropic\/claude-opus-4-8:high/);
		assert.equal(watchdog.getSnapshot(tempDir).config.main.model, "anthropic/claude-opus-4-8");
	});

	it("rejects duplicate concurrent subagent execution calls", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Duplicate call" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("blocks total subagent spawns after the per-session quota", async () => {
		mockPi.onCall({ output: "first call completed" });
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 });
		const ctx = makeMinimalCtx(tempDir);

		const first = await executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Second call" }, new AbortController().signal, undefined, ctx);

		assert.equal(first.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Subagent spawn limit reached for this session \(1\/1 used, 1 requested\)/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows management actions while an execution call is in progress", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(status.isError, undefined);
		assert.doesNotMatch(status.content[0]?.text ?? "", /Rejected: a subagent call is already in progress/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows intentional parallel tasks inside one subagent execution call", async () => {
		mockPi.onCall({ output: "first parallel result" });
		mockPi.onCall({ output: "second parallel result" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

		const result = await executor.execute(
			"parallel",
			{ tasks: [{ agent: "echo", task: "First task" }, { agent: "second", task: "Second task" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 200, outputTokens: 100, costUsd: 0.002 });
	});

	it("reports total cost for foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single result" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-cost",
			{ agent: "echo", task: "Single task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
	});

	it("fails implementation runs that complete without mutation attempts", async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "failed");
		assert.deepEqual(controlEvents.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
		assert.deepEqual(result.controlEvents?.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
	});

	it("returns captured output when the foreground executor fails an implementation run", async () => {
		mockPi.onCall({ output: "Oracle review:\n- finding one\n- finding two" });
		const executor = makeExecutor([makeAgent("oracle")]);

		const result = await executor.execute(
			"failed-single-output",
			{ agent: "oracle", task: "Implement the approved file changes" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.match(text, /completed without making edits/);
		assert.match(text, /Output:\nOracle review:\n- finding one\n- finding two/);
		assert.match(text, /Output artifact: /);
	});

	it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows declared read-only agents to mention implementation words without edits", async () => {
		mockPi.onCall({ output: "Validation report after the patch" });
		const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

		const result = await runSync(tempDir, agents, "architect", "Produce a proposal that implements the approved fix", {
			runId: "guard-readonly-tools",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Validation report after the patch");
	});

	it("keeps bash-enabled implementation tasks conservative unless completion guard is disabled", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Patch the cold start test", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 1);
		assert.match(withoutOptOut.error ?? "", /completed without making edits/);

		const withOptOut = await runSync(tempDir, agents, "test-runner-optout", "Patch the cold start test", {
			runId: "guard-bash-optout",
		});
		assert.equal(withOptOut.exitCode, 0);
		assert.equal(withOptOut.progress.status, "completed");
	});

	it("allows implementation runs when parsed messages include a real edit tool call", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				events.assistantMessage("Applied edit"),
			],
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-success",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});


	it("emits an active-long-running notice after the turn threshold", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-active",
			controlConfig: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.length, 1);
		assert.equal(controlEvents[0]?.type, "active_long_running");
		assert.equal(controlEvents[0]?.reason, "turn_threshold");
		assert.equal(controlEvents[0]?.turns, 2);
		assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
		assert.equal(result.progress.activityState, "active_long_running");
	});

	it("escalates repeated mutating tool failures to needs attention", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.assistantMessage("I need to retry the same edit."),
			],
		});
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "run-failures",
			controlConfig: { enabled: true, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
		assert.equal(failureEvent?.type, "needs_attention");
		assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
		assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("does not surface control state or events when control is disabled", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-control-disabled",
			controlConfig: { enabled: false, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 1, activeNoticeAfterTokens: 1, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.controlEvents, undefined);
		assert.equal(controlEvents.length, 0);
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("prefers the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			preferredModelProvider: "github-copilot",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("retries with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-sync",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.modelAttempts?.length, 2);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.equal(result.modelAttempts?.[1]?.success, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("retries with fallback models when provider errors exit zero", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
	});

	it("retries with fallback models when a zero-exit attempt has empty output", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "openai/gpt-5-mini",
					stopReason: "error",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered from empty output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-empty-output",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.equal(result.finalOutput, "Recovered from empty output");
		assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("fails zero-exit provider errors when no fallback succeeds", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-no-fallback",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /429 quota exceeded/);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false]);
	});

	it("treats recovered child tool errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				events.assistantMessage("Done"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Inspect files", {
			runId: "recovered-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Done");
		assert.equal(getFinalOutput(result.messages), "Done");
		assert.equal(result.progress.status, "completed");
	});

	it("treats recovered assistant provider errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "recovered-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Recovered");
		assert.equal(getFinalOutput(result.messages), "Recovered");
		assert.equal(result.progress.status, "completed");
	});

	it("keeps provider errors failed when followed only by empty assistant output", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "provider-error-empty-stop",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /provider transport failed/);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "failed");
	});

	it("fails when all fallback model attempts report provider errors", async () => {
		for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
			mockPi.onCall({
				jsonl: [{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${model} quota hit` }],
						model,
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				}],
				exitCode: 0,
			});
		}
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-all-fallbacks-fail",
		});

		assert.equal(result.exitCode, 1);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, false]);
		assert.match(result.error ?? "", /429 quota exceeded/);
	});

	it("baselines output files per fallback attempt", async () => {
		const outputPath = path.join(tempDir, "fallback-output.md");
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
			delay: 100,
		});
		mockPi.onCall({ output: "fallback assistant output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-output-per-attempt",
			outputPath,
		});
		setTimeout(() => {
			fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
		}, 20);

		const result = await runPromise;

		assert.equal(result.exitCode, 0);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
	});

	it("does not retry on ordinary task/tool failures", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "process exited with code 127")],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-task-failure",
		});

		assert.equal(result.exitCode, 127);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("tracks progress during execution", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("tracks live activity updates and exposes artifact paths while running", async () => {
		const updates: Array<{ details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{\"name\":\"pkg\"}")], delay: 20 },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "live-progress",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }) => {
				updates.push(update);
			},
		});

		assert.ok(updates.length > 0, "expected at least one live progress update");
		assert.equal(
			updates.some((update) => update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true),
			true,
		);
		const runningToolUpdate = updates.find((update) => update.details?.progress?.[0]?.currentTool === "read");
		assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
		assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
		assert.equal(typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt, "number");
		assert.equal(typeof result.progress.lastActivityAt, "number");
		assert.equal(result.progress.currentToolStartedAt, undefined);
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.txt\nfile2.txt"),
				events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
			],
		});
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("resolves skills from the effective task cwd", async () => {
		const taskCwd = createTempDir("pi-subagent-task-cwd-");
		try {
			writePackageSkill(taskCwd, "task-cwd-skill");
			mockPi.onCall({ output: "Done" });
			const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

			const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.skills, ["task-cwd-skill"]);
			assert.equal(result.skillsWarning, undefined);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
		const taskCwd = path.join(tempDir, "nested");
		fs.mkdirSync(taskCwd, { recursive: true });
		writePackageSkill(tempDir, "runtime-fallback-skill");
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

		const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
		assert.equal(result.skillsWarning, undefined);
	});

	it("fails foreground runs on explicit unavailable pi-subagents skill requests without spawning", async () => {
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-subagents"] });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("fails foreground runs when an agent default requests pi-subagents skill", async () => {
		const agents = [makeAgent("worker", { skills: ["pi-subagents"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("writes artifacts when configured", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(result.transcriptPath, "should expose transcript path on the result");
		assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
		assert.ok(fs.existsSync(result.transcriptPath), "transcript should be written");
		const transcript = fs.readFileSync(result.transcriptPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { recordType?: string; source?: string; text?: string });
		assert.equal(transcript[0]?.recordType, "message");
		assert.equal(transcript[0]?.source, "foreground");
		assert.match(transcript.at(-1)?.text ?? "", /^Result text/);
		assert.equal(result.transcriptError, undefined);
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
	});

	it("does not surface transcript paths when transcript artifacts are disabled", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts-disabled-transcript");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run-no-transcript",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeTranscript: false, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.transcriptPath, undefined);
		assert.equal(result.transcriptError, undefined);
		assert.ok(result.artifactPaths?.metadataPath, "should have metadata path");
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { transcriptPath?: string; transcriptError?: string };
		assert.equal(metadata.transcriptPath, undefined);
		assert.equal(metadata.transcriptError, undefined);
		assert.equal(fs.existsSync(result.artifactPaths.transcriptPath!), false);
	});

	it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
		const outputPath = path.join(tempDir, "report.md");
		const artifactsDir = path.join(tempDir, "artifacts");
		mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
		const agents = makeAgentConfigs(["echo"]);

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-preserved",
			outputPath,
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		setTimeout(() => {
			fs.writeFileSync(outputPath, "real file content", "utf-8");
		}, 20);

		const result = await runPromise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "real file content");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting assistant output when the target file was not changed", async () => {
		const outputPath = path.join(tempDir, "report.md");
		fs.writeFileSync(outputPath, "stale content", "utf-8");
		mockPi.onCall({ output: "fresh assistant output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-fallback",
			outputPath,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "fresh assistant output");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("routes foreground single relative outputs to the run output artifact directory by default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default report" });
		const executor = makeExecutor([makeAgent("researcher", { output: "context.md" })]);

		const result = await executor.execute(
			"single-default-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(path.join(tempDir, ".pi-subagents", "artifacts", "outputs"))}.*context\\.md`));
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("routes foreground single relative outputs to configured singleRunOutputBaseDir", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "configured report" });
		const configuredBase = path.join(tempDir, "configured-outputs");
		const executor = makeExecutor(
			[makeAgent("researcher", { output: "context.md" })],
			{ singleRunOutputBaseDir: configuredBase },
		);

		const result = await executor.execute(
			"single-configured-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const expectedOutputPath = path.join(configuredBase, "context.md");
		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(expectedOutputPath)}`));
		assert.equal(fs.readFileSync(expectedOutputPath, "utf-8"), "configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("makes task-level output overrides authoritative in the child system prompt", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "override report" });
		const overridePath = path.join(tempDir, "custom-report.md");
		const executor = makeExecutor([
			makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
		]);

		const result = await executor.execute(
			"single-output-override-system-prompt",
			{ agent: "researcher", task: "Write report", output: overridePath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const call = readCall();
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
	});

	it("treats string false as disabled output in foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-string-false-output",
			{ agent: "echo", task: "Write report", output: "false" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("rejects mismatched foreground timeout aliases before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-alias-validation",
			{ agent: "echo", task: "Task", timeoutMs: 100, maxRuntimeMs: 200 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /aliases/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("blocks an incompatible configured remote-pi before spawning child Pi", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = path.join(tempDir, "old-remote-agent-dir");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "remote-pi"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:remote-pi@0.5.4"] }), "utf8");
		fs.writeFileSync(path.join(agentDir, "npm", "node_modules", "remote-pi", "package.json"), JSON.stringify({
			name: "remote-pi",
			version: "0.5.4",
			pi: { extensions: ["./dist/index.js"] },
		}), "utf8");
		try {
			const executor = makeExecutor();
			const result = await executor.execute(
				"incompatible-remote",
				{ agent: "echo", task: "Task" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /does not declare child-session protocol compatibility/i);
			assert.equal(mockPi.callCount(), 0, "child Pi must not wake before compatibility passes");
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});

	it("applies agent frontmatter defaults to single-agent launches", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("echo", {
				defaultAsync: true,
				defaultTimeoutMs: 2_000,
				defaultTurnBudget: { maxTurns: 4, graceTurns: 2 },
			}),
		]);

		const result = await executor.execute(
			"agent-launch-defaults",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(typeof result.details?.asyncId, "string");
		assert.equal(result.details?.timeoutMs, 2_000);
		assert.deepEqual(result.details?.turnBudget, { maxTurns: 4, graceTurns: 2 });
	});

	it("lets authorized relay intent carry one process-bound capability without suppressing extensions", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const relayCapability = `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
		const eventBus = createEventBus();
		let issueRequests = 0;
		const issueSources: unknown[] = [];
		const lifecycleRequests: Array<Record<string, unknown>> = [];
		let issuedLease: Record<string, unknown> | undefined;
		eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string; method: string; binding: Record<string, unknown>; intentSource?: unknown };
			if (request.method === "issue") {
				issueRequests++;
				issueSources.push(request.intentSource);
				const issuedAt = Date.now();
				issuedLease = {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					parent: {
						workspaceId: request.binding.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
					binding: request.binding,
					issuedAt,
					expiresAt: issuedAt + 60_000,
				};
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1,
					requestId: request.requestId,
					success: true,
					ok: true,
					capability: relayCapability,
					lease: issuedLease,
				});
				return;
			}
			lifecycleRequests.push(raw as Record<string, unknown>);
			eventBus.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: true,
				ok: true,
				state: request.method === "close" ? "closed" : "idempotent",
				lease: issuedLease,
			});
		});
		mockPi.onCall({ echoEnv: [CHILD_SESSION_DESCRIPTOR_ENV, RELAY_EXPOSURE_CAPABILITY_ENV] });
		const executor = makeExecutor([makeAgent("echo", { exposure: "relay" })], {}, false, eventBus);
		const inherited = await executor.execute(
			"agent-exposure-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const inheritedEnv = JSON.parse(inherited.details?.results?.[0]?.finalOutput ?? "{}");
		const inheritedDescriptor = JSON.parse(inheritedEnv[CHILD_SESSION_DESCRIPTOR_ENV] ?? "null");
		assert.equal(inheritedDescriptor.requestedExposure, "relay");
		assert.equal(inheritedDescriptor.intentSource, "agent");
		assert.equal(inheritedEnv[RELAY_EXPOSURE_CAPABILITY_ENV], relayCapability);
		assert.equal(issueRequests, 1);
		assert.deepEqual(issueSources, ["agent"]);
		assert.deepEqual(lifecycleRequests.map((request) => request.method), ["close"]);
		assert.equal(lifecycleRequests[0]?.reason, "completed");
		assert.equal("capability" in (lifecycleRequests[0] ?? {}), false);
		assert.ok(!readCallArgs().includes("--no-extensions"));

		mockPi.onCall({ echoEnv: [CHILD_SESSION_DESCRIPTOR_ENV, RELAY_EXPOSURE_CAPABILITY_ENV] });
		const fallback = await makeExecutor([makeAgent("echo")], {}, false, eventBus).execute(
			"remote-policy-fallback",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const fallbackEnv = JSON.parse(fallback.details?.results?.[0]?.finalOutput ?? "{}");
		const fallbackDescriptor = JSON.parse(fallbackEnv[CHILD_SESSION_DESCRIPTOR_ENV] ?? "null");
		assert.equal(fallbackDescriptor.requestedExposure, "local");
		assert.equal(fallbackDescriptor.intentSource, "fallback");
		assert.equal(fallbackEnv[RELAY_EXPOSURE_CAPABILITY_ENV], relayCapability);
		assert.equal(issueRequests, 2);
		assert.deepEqual(issueSources, ["agent", "fallback"]);

		mockPi.onCall({ echoEnv: [CHILD_SESSION_DESCRIPTOR_ENV, RELAY_EXPOSURE_CAPABILITY_ENV] });
		const overridden = await executor.execute(
			"explicit-exposure",
			{ agent: "echo", task: "Task", exposure: "off" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const overriddenEnv = JSON.parse(overridden.details?.results?.[0]?.finalOutput ?? "{}");
		const overriddenDescriptor = JSON.parse(overriddenEnv[CHILD_SESSION_DESCRIPTOR_ENV] ?? "null");
		assert.equal(overriddenDescriptor.requestedExposure, "off");
		assert.equal(overriddenDescriptor.intentSource, "run");
		assert.equal(overriddenEnv[RELAY_EXPOSURE_CAPABILITY_ENV], "");
		assert.equal(issueRequests, 2, "off exposure must not request a relay capability");
		assert.ok(!readCallArgs().includes("--no-extensions"));

		mockPi.onCall({ echoEnv: [CHILD_SESSION_DESCRIPTOR_ENV, RELAY_EXPOSURE_CAPABILITY_ENV] });
		const allowlisted = await makeExecutor([
			makeAgent("echo", { exposure: "relay", extensions: ["./allowed-ext.ts"] }),
		], {}, false, eventBus).execute(
			"allowlisted-exposure",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const allowlistedEnv = JSON.parse(allowlisted.details?.results?.[0]?.finalOutput ?? "{}");
		const allowlistedDescriptor = JSON.parse(allowlistedEnv[CHILD_SESSION_DESCRIPTOR_ENV] ?? "null");
		assert.equal(allowlistedDescriptor.intentSource, "agent");
		assert.equal(allowlistedEnv[RELAY_EXPOSURE_CAPABILITY_ENV], "");
		assert.equal(issueRequests, 2, "an allowlist without remote-pi must not receive a bearer");
		assert.ok(readCallArgs().includes("--no-extensions"));
	});

	it("promotes and demotes a detached foreground child through the parent exposure action", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
		timeout: 5_000,
	}, async () => {
		const eventBus = createEventBus();
		let lease: Record<string, unknown> | undefined;
		const lifecycleMethods: string[] = [];
		eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string; method: string; binding: Record<string, unknown> };
			lifecycleMethods.push(request.method);
			if (request.method === "promote") {
				const issuedAt = Date.now();
				lease = {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					parent: {
						workspaceId: request.binding.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
					binding: request.binding,
					issuedAt,
					expiresAt: issuedAt + 30_000,
				};
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true, state: "promoted", lease,
				});
				return;
			}
			eventBus.emit(relayExposureReplyEvent(request.requestId), {
				version: 1,
				requestId: request.requestId,
				success: true,
				ok: true,
				state: request.method === "revoke" ? "revoked" : "closed",
				lease,
			});
		});
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("request_relay_exposure", { mode: "relay", ttlMs: 30_000 })] },
				{ delay: 750, jsonl: [events.assistantMessage("detached child finished")] },
			],
		});
		const executor = makeExecutor([
			makeAgent("echo", { exposure: "local", extensions: ["npm:remote-pi"], systemPrompt: "Intercom orchestration channel:\nUse request_relay_exposure." }),
		], {}, false, eventBus);
		const ctx = makeMinimalCtx(tempDir);
		let detachEmitted = false;
		const run = executor.execute(
			"live-exposure-run",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			(update) => {
				if (detachEmitted) return;
				const progress = update.details?.progress;
				if (!progress?.some((entry) => entry.currentTool === "request_relay_exposure")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "live-exposure-detach", agent: "echo", childIndex: 0 });
			},
			ctx,
		);
		const detached = await run;
		assert.match(detached.content[0]?.text ?? "", /Detached/i);
		const liveRunId = detached.details?.runId;
		assert.equal(typeof liveRunId, "string");

		const promoted = await executor.execute(
			"promote-live-exposure",
			{ action: "exposure", id: liveRunId, index: 0, exposure: "relay", ttlMs: 30_000 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(promoted.isError, undefined, JSON.stringify(promoted));
		assert.match(promoted.content[0]?.text ?? "", /promoted|relay/i);

		const demoted = await executor.execute(
			"demote-live-exposure",
			{ action: "exposure", id: liveRunId, index: 0, exposure: "local" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(demoted.isError, undefined);
		assert.match(demoted.content[0]?.text ?? "", /revoked|local|demoted/i);
		assert.deepEqual(lifecycleMethods.slice(0, 2), ["promote", "revoke"]);
		assert.equal(JSON.stringify(promoted).includes("rpel1."), false);

		await new Promise((resolve) => setTimeout(resolve, 900));
		const stale = await executor.execute(
			"stale-live-exposure",
			{ action: "exposure", id: liveRunId, index: 0, exposure: "relay" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(stale.isError, true);
		assert.match(stale.content[0]?.text ?? "", /no live foreground/i);
	});

	it("emits a typed timeout close for an authorized foreground relay child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const relayCapability = `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
		const eventBus = createEventBus();
		let issuedLease: Record<string, unknown> | undefined;
		const closeReasons: unknown[] = [];
		eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string; method: string; binding: Record<string, unknown>; reason?: unknown };
			if (request.method === "issue") {
				const issuedAt = Date.now();
				issuedLease = {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					parent: {
						workspaceId: request.binding.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
					binding: request.binding,
					issuedAt,
					expiresAt: issuedAt + 60_000,
				};
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true,
					capability: relayCapability, lease: issuedLease,
				});
				return;
			}
			if (request.method === "close") closeReasons.push(request.reason);
			eventBus.emit(relayExposureReplyEvent(request.requestId), {
				version: 1, requestId: request.requestId, success: true, ok: true,
				state: "closed", lease: issuedLease,
			});
		});
		mockPi.onCall({ delay: 10_000 });
		const executor = makeExecutor([makeAgent("slow", { exposure: "relay" })], {}, false, eventBus);
		await executor.execute(
			"relay-timeout",
			{ agent: "slow", task: "Task", timeoutMs: 150 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.deepEqual(closeReasons, ["timeout"]);
	});

	it("emits controlled_shutdown instead of completed for a nonzero foreground exit", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const relayCapability = `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
		const eventBus = createEventBus();
		let issuedLease: Record<string, unknown> | undefined;
		const closeReasons: unknown[] = [];
		eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string; method: string; binding: Record<string, unknown>; reason?: unknown };
			if (request.method === "issue") {
				const issuedAt = Date.now();
				issuedLease = {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					parent: {
						workspaceId: request.binding.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
					binding: request.binding,
					issuedAt,
					expiresAt: issuedAt + 60_000,
				};
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true,
					capability: relayCapability, lease: issuedLease,
				});
				return;
			}
			if (request.method === "close") closeReasons.push(request.reason);
			eventBus.emit(relayExposureReplyEvent(request.requestId), {
				version: 1, requestId: request.requestId, success: true, ok: true,
				state: "closed", lease: issuedLease,
			});
		});
		mockPi.onCall({ exitCode: 1, stderr: "child process failed" });
		await makeExecutor([makeAgent("failing", { exposure: "relay" })], {}, false, eventBus).execute(
			"relay-nonzero-exit",
			{ agent: "failing", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.deepEqual(closeReasons, ["controlled_shutdown"]);
	});

	it("retries a lost foreground renewal reply with the same renewal ID before close", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
		timeout: 7_000,
	}, async () => {
		const relayCapability = `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
		const eventBus = createEventBus();
		let lease: Record<string, unknown> | undefined;
		const renewalIds: unknown[] = [];
		const closeRequests: Array<Record<string, unknown>> = [];
		eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as {
				requestId: string;
				method: string;
				binding: Record<string, unknown>;
				renewalId?: unknown;
			};
			if (request.method === "issue") {
				const issuedAt = Date.now();
				lease = {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					parent: {
						workspaceId: request.binding.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
					binding: request.binding,
					issuedAt,
					expiresAt: issuedAt + 2_500,
				};
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true,
					capability: relayCapability, lease,
				});
				return;
			}
			if (request.method === "renew") {
				renewalIds.push(request.renewalId);
				lease = { ...lease!, expiresAt: Date.now() + 60_000 };
				if (renewalIds.length === 1) return; // broker applied it; reply was lost
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true,
					state: "idempotent", lease,
				});
				return;
			}
			if (request.method === "close") closeRequests.push(raw as Record<string, unknown>);
			eventBus.emit(relayExposureReplyEvent(request.requestId), {
				version: 1, requestId: request.requestId, success: true, ok: true,
				state: "closed", lease,
			});
		});

		mockPi.onCall({ delay: 2_200, output: "renewed foreground finished" });
		const executor = makeExecutor([makeAgent("slow", { exposure: "relay" })], {}, false, eventBus);
		await executor.execute(
			"relay-renew-retry",
			{ agent: "slow", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(renewalIds.length, 2);
		assert.equal(renewalIds[0], renewalIds[1], "a lost reply must retry the identical renewal operation");
		assert.equal(closeRequests.length, 1);
		assert.equal(closeRequests[0]?.reason, "completed");
		assert.equal("capability" in closeRequests[0]!, false);
	});

	it("does not retry after the current foreground lease expires", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
		timeout: 7_000,
	}, async () => {
		const relayCapability = `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
		const eventBus = createEventBus();
		let lease: Record<string, unknown> | undefined;
		let leaseExpiresAt = 0;
		const renewalRequestTimes: number[] = [];
		eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string; method: string; binding: Record<string, unknown> };
			if (request.method === "issue") {
				const issuedAt = Date.now();
				leaseExpiresAt = issuedAt + 1_005;
				lease = {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					parent: {
						workspaceId: request.binding.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
					binding: request.binding,
					issuedAt,
					expiresAt: leaseExpiresAt,
				};
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true,
					capability: relayCapability, lease,
				});
				return;
			}
			if (request.method === "renew") {
				renewalRequestTimes.push(Date.now());
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: false, reason: "broker_unavailable",
				});
				return;
			}
			eventBus.emit(relayExposureReplyEvent(request.requestId), {
				version: 1, requestId: request.requestId, success: true, ok: true,
				state: "closed", lease,
			});
		});

		mockPi.onCall({ delay: 1_250, output: "expired renewal finished" });
		await makeExecutor([makeAgent("slow", { exposure: "relay" })], {}, false, eventBus).execute(
			"relay-renew-expiry",
			{ agent: "slow", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const renewalCountAtExit = renewalRequestTimes.length;
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(renewalRequestTimes.length, renewalCountAtExit, "no retry may fire after the current lease expires");
		assert.equal(renewalRequestTimes.length <= 2, true, "one renewal plus at most one same-operation retry is bounded");
		assert.equal(renewalRequestTimes.every((requestedAt) => requestedAt < leaseExpiresAt), true);
	});

	it("waits for an in-flight renewal before close without rearming a timer", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
		timeout: 7_000,
	}, async () => {
		const relayCapability = `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
		const eventBus = createEventBus();
		let lease: Record<string, unknown> | undefined;
		const lifecycleOrder: string[] = [];
		let renewals = 0;
		eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
			const request = raw as { requestId: string; method: string; binding: Record<string, unknown> };
			if (request.method === "issue") {
				const issuedAt = Date.now();
				lease = {
					relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
					parent: {
						workspaceId: request.binding.workspaceId,
						agentId: "55555555-5555-4555-8555-555555555555",
						processEpoch: "66666666-6666-4666-8666-666666666666",
					},
					binding: request.binding,
					issuedAt,
					expiresAt: issuedAt + 2_000,
				};
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true,
					capability: relayCapability, lease,
				});
				return;
			}
			if (request.method === "renew") {
				renewals++;
				lifecycleOrder.push("renew");
				lease = { ...lease!, expiresAt: Date.now() + 60_000 };
				setTimeout(() => {
					lifecycleOrder.push("renew-reply");
					eventBus.emit(relayExposureReplyEvent(request.requestId), {
						version: 1, requestId: request.requestId, success: true, ok: true,
						state: "renewed", lease,
					});
				}, 150);
				return;
			}
			if (request.method === "close") lifecycleOrder.push("close");
			eventBus.emit(relayExposureReplyEvent(request.requestId), {
				version: 1, requestId: request.requestId, success: true, ok: true,
				state: "closed", lease,
			});
		});

		mockPi.onCall({ delay: 1_050, output: "renewal race finished" });
		const executor = makeExecutor([makeAgent("slow", { exposure: "relay" })], {}, false, eventBus);
		await executor.execute(
			"relay-renew-close-race",
			{ agent: "slow", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));

		assert.deepEqual(lifecycleOrder, ["renew", "renew-reply", "close"]);
		assert.equal(renewals, 1, "lifecycle stop must not leave a renewal timer armed");
	});

	for (const lifecycleCase of [
		{ name: "soft interrupt", signalKey: "interruptSignal" as const, expected: "interrupted" },
		{ name: "outer controlled shutdown", signalKey: "signal" as const, expected: "controlled_shutdown" },
	]) {
		it(`emits typed ${lifecycleCase.expected} close for ${lifecycleCase.name}`, { timeout: 7_000 }, async () => {
			const relayCapability = `rpel1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
			const eventBus = createEventBus();
			let lease: Record<string, unknown> | undefined;
			const closeReasons: unknown[] = [];
			eventBus.on(RELAY_EXPOSURE_REQUEST_EVENT, (raw) => {
				const request = raw as { requestId: string; method: string; binding: Record<string, unknown>; reason?: unknown };
				if (request.method === "issue") {
					const issuedAt = Date.now();
					lease = {
						relayExposureLeaseId: "44444444-4444-4444-8444-444444444444",
						parent: {
							workspaceId: request.binding.workspaceId,
							agentId: "55555555-5555-4555-8555-555555555555",
							processEpoch: "66666666-6666-4666-8666-666666666666",
						},
						binding: request.binding,
						issuedAt,
						expiresAt: issuedAt + 60_000,
					};
					eventBus.emit(relayExposureReplyEvent(request.requestId), {
						version: 1, requestId: request.requestId, success: true, ok: true,
						capability: relayCapability, lease,
					});
					return;
				}
				if (request.method === "close") closeReasons.push(request.reason);
				eventBus.emit(relayExposureReplyEvent(request.requestId), {
					version: 1, requestId: request.requestId, success: true, ok: true,
					state: "closed", lease,
				});
			});
			mockPi.onCall({ delay: 10_000 });
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 200);
			await runSync(tempDir, [makeAgent("slow", { exposure: "relay" })], "slow", "Task", {
				runId: `relay-${lifecycleCase.signalKey}`,
				intercomEvents: eventBus,
				[lifecycleCase.signalKey]: controller.signal,
			});
			assert.deepEqual(closeReasons, [lifecycleCase.expected]);
		});
	}

	it("lets agent frontmatter override the global async default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "agent foreground default finished" });
		const executor = makeExecutor(
			[makeAgent("echo", { defaultAsync: false })],
			{},
			true,
		);

		const result = await executor.execute(
			"agent-foreground-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /agent foreground default finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("lets explicit single-agent launch values override frontmatter defaults", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "explicit foreground finished" });
		const executor = makeExecutor([
			makeAgent("echo", {
				defaultAsync: true,
				defaultTimeoutMs: 1,
				defaultTurnBudget: { maxTurns: 1, graceTurns: 0 },
			}),
		]);

		const result = await executor.execute(
			"explicit-launch-values",
			{
				agent: "echo",
				task: "Task",
				async: false,
				timeoutMs: 2_000,
				turnBudget: { maxTurns: 4, graceTurns: 2 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /explicit foreground finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("allows timeout settings for async runs before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-async-validation",
			{ agent: "echo", task: "Task", async: true, timeoutMs: 1_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(result.details?.timeoutMs, 1_000);
	});

	it("rejects file-only mode without an output path before spawning", async () => {
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only-missing-path",
			outputMode: "file-only",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns only a saved-output reference in file-only mode", async () => {
		const outputPath = path.join(tempDir, "file-only-report.md");
		const artifactsDir = path.join(tempDir, "file-only-artifacts");
		mockPi.onCall({ output: "full saved output\nwith details" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only",
			outputPath,
			outputMode: "file-only",
			artifactsDir,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.outputMode, "file-only");
		assert.equal(result.savedOutputPath, outputPath);
		assert.equal(result.outputReference?.path, outputPath);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.match(result.finalOutput ?? "", /2 lines/);
		assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "full saved output\nwith details");
	});

	it("passes maxSubagentDepth through to child execution env", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const agents = makeAgentConfigs(["echo"]);
		const prevDepth = process.env.PI_SUBAGENT_DEPTH;
		const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;

		try {
			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: "depth-env",
				maxSubagentDepth: 1,
			});

			assert.equal(result.exitCode, 0);
			assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = prevDepth;
			if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
		}
	});

	it("passes prompt inheritance env flags through to child execution", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"] });
		const agents = [makeAgent("echo", {
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "prompt-inheritance-env",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
			PI_SUBAGENT_INHERIT_SKILLS: "0",
		});
	});

	it("passes fanout routing env only when builtin subagent is declared", async () => {
		const envKeys = [
			SUBAGENT_FANOUT_CHILD_ENV,
			SUBAGENT_PARENT_EVENT_SINK_ENV,
			SUBAGENT_PARENT_CONTROL_INBOX_ENV,
			SUBAGENT_PARENT_RUN_ID_ENV,
			SUBAGENT_PARENT_CHILD_INDEX_ENV,
		];
		const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
		try {
			process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events.jsonl";
			process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
			process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
			process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "7";

			mockPi.onCall({ echoEnv: envKeys });
			const fanoutAgents = [makeAgent("delegator", { tools: ["read", "subagent"] })];
			const fanout = await runSync(tempDir, fanoutAgents, "delegator", "Task", { runId: "fanout-run", index: 2 });
			assert.equal(fanout.exitCode, 0);
			assert.deepEqual(JSON.parse(fanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "1",
				PI_SUBAGENT_PARENT_EVENT_SINK: "/tmp/inherited/events.jsonl",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "/tmp/inherited/control",
				PI_SUBAGENT_PARENT_RUN_ID: "fanout-run",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "2",
			});

			mockPi.onCall({ echoEnv: envKeys });
			const nonFanoutAgents = [makeAgent("worker", { tools: ["read"] })];
			const nonFanout = await runSync(tempDir, nonFanoutAgents, "worker", "Task", { runId: "non-fanout-run" });
			assert.equal(nonFanout.exitCode, 0);
			assert.deepEqual(JSON.parse(nonFanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "0",
				PI_SUBAGENT_PARENT_EVENT_SINK: "",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "",
				PI_SUBAGENT_PARENT_RUN_ID: "",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "",
			});
		} finally {
			for (const key of envKeys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});

	it("passes supervisor metadata through to child execution", async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_INTERCOM_SESSION_NAME",
			"PI_SUBAGENT_ORCHESTRATOR_TARGET",
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "78f659a3",
			index: 2,
			intercomSessionName: "subagent-echo-78f659a3-3",
			orchestratorIntercomTarget: "subagent-chat-parent",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: "subagent-echo-78f659a3-3",
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_RUN_ID: "78f659a3",
			PI_SUBAGENT_CHILD_AGENT: "echo",
			PI_SUBAGENT_CHILD_INDEX: "2",
		});
	});

	it("passes custom tool extensions through even when explicit extensions are allowlisted", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "tool-extension-allowlist",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("custom-tool.ts")));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("allowed-ext.ts")));
	});

	it("passes subagent-only extensions through to child execution", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read"],
			subagentOnlyExtensions: ["./child-only-tool.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "subagent-only-extension",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("child-only-tool.ts")));
	});

	it("ignores child watchdog status when foreground child watchdogs are not configured", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			mockPi.onCall({
				jsonl: [events.assistantMessage("done-without-watchdog-config"), childWatchdogStatus("reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 5000, `unconfigured watchdog status should not delay final drain, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-without-watchdog-config");
			assert.equal((result as RunSyncResult & { watchdog?: unknown }).watchdog, undefined);
		});
	});

	it("waits for child watchdog settlement before foreground final-drain cleanup", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("done-before-watchdog"), childWatchdogStatus("reviewing", 1)] },
					{ delay: 1400, jsonl: [childWatchdogStatus("idle", 2)] },
				],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed >= 1200, `watchdog settlement should delay final drain, took ${elapsed}ms`);
			assert.ok(elapsed < 6000, `settled watchdog should still allow cleanup, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-before-watchdog");
			assert.equal((result as RunSyncResult & { watchdog?: { phase?: string } }).watchdog?.phase, "idle");
		});
	});

	it("falls back after child watchdog tail timeout without failing successful foreground output", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir, 150);
			mockPi.onCall({
				jsonl: [events.assistantMessage("done-before-watchdog-timeout"), childWatchdogStatus("reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 5000, `watchdog tail fallback should not hang, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-before-watchdog-timeout");
			const watchdog = (result as RunSyncResult & { watchdog?: { phase?: string; timedOut?: boolean } }).watchdog;
			assert.equal(watchdog?.phase, "stale");
			assert.equal(watchdog?.timedOut, true);
		});
	});

	it("treats forced drain after final assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done-before-drain");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "completed");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.progress.status, "failed");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("marks foreground runs that exceed timeoutMs as timed out", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.timedOut, true);
		assert.equal(result.error, "Subagent timed out after 150ms.");
		assert.match(result.finalOutput ?? "", /Subagent timed out after 150ms\./);
		assert.equal(result.progress.status, "failed");
	});

	it("allows a foreground run to finish on the final turn-budget grace turn", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("working before wrap-up", "tool_use"),
				mockAssistantMessage("final wrapped output", "stop"),
			],
		});
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Use the final grace turn to wrap up.", {
			turnBudget: { maxTurns: 1, graceTurns: 1 },
			runId: "foreground-turn-budget-soft",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.turnBudgetExceeded, undefined);
		assert.equal(result.wrapUpRequested, true);
		assert.equal(result.turnBudget?.outcome, "wrap-up-requested");
		assert.equal(result.turnBudget?.turnCount, 2);
		assert.match(result.finalOutput ?? "", /Turn budget wrap-up was requested after 1 assistant turn/);
		assert.match(result.finalOutput ?? "", /final wrapped output/);
	});

	it("does not run acceptance verification after a foreground timeout", async () => {
		const markerPath = path.join(tempDir, "verify-ran.txt");
		const report = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
			}),
			"```",
		].join("\n");
		mockPi.onCall({ jsonl: [events.assistantMessage(report)], keepAliveAfterFinalMessageMs: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
			acceptance: {
				level: "verified",
				verify: [{
					id: "marker",
					command: "node -e \"require('node:fs').writeFileSync(process.env.VERIFY_MARKER, 'ran')\"",
					env: { VERIFY_MARKER: markerPath },
					timeoutMs: 10_000,
				}],
			},
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.acceptance?.status, "rejected");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.equal(result.acceptance?.verifyRuns?.length, 0);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("soft-interrupts the current turn and returns a paused result", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		const controlEvents: Array<{ type?: string; to?: string }> = [];

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "interrupt-run",
			interruptSignal: controller.signal,
			onControlEvent: (event: { type?: string; to?: string }) => {
				controlEvents.push(event);
			},
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.progress.activityState, undefined);
		assert.deepEqual(controlEvents, []);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("preserves manual interrupt semantics when a timeout is also configured", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 100);
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			interruptSignal: controller.signal,
			timeoutMs: 500,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.error, undefined);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	for (const toolName of ["intercom", "contact_supervisor"]) {
		it(`detaches cleanly on ${toolName} handoff without aborting the child process`, async () => {
			const eventBus = createEventBus();
			let accepted = false;
			eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
				if (!payload || typeof payload !== "object") return;
				accepted = (payload as { accepted?: unknown }).accepted === true;
			});
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(toolName, toolName === "intercom" ? { action: "ask", to: "orchestrator" } : { reason: "need_decision", message: "Need a decision" })] },
					{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			// Emit the detach request the moment we observe the coordination tool start
			// in a progress update — this is the signal the parent has set
			// `intercomStarted=true`. Using a fixed delay here races the mock's
			// cold spawn and flakes under load.
			let detachEmitted = false;
			const runPromise = runSync(tempDir, agents, "echo", "Task", {
				runId: `${toolName}-detach`,
				allowIntercomDetach: true,
				intercomEvents: eventBus,
				onUpdate: (update) => {
					if (detachEmitted) return;
					const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
					const sawCoordinationTool = Array.isArray(progress) && progress.some((p) => p?.currentTool === toolName);
					if (!sawCoordinationTool) return;
					detachEmitted = true;
					eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "test-request" });
				},
			});

			const result = await runPromise;

			assert.equal(result.exitCode, -2);
			assert.equal(result.detached, true);
			assert.equal(result.detachedReason, "intercom coordination");
			assert.equal(result.finalOutput, "Detached for intercom coordination before task completion.");
			assert.equal(result.progress?.status, "detached");
			assert.equal(accepted, true);
		});
	}

	it("does not save a detached placeholder to an explicit file-only output", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-output.md");
		let detachEmitted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-detach" });
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(result.savedOutputPath, undefined);
		assert.equal(fs.existsSync(outputPath), false);
		assert.match(result.outputSaveError ?? "", /not finalized/);
	});

	it("finalizes explicit output before reporting detached child post-exit success", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 100, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-final-output.md");
		let detachEmitted = false;
		let recoveredResult: RunSyncResult | undefined;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-post-exit-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-post-exit-detach" });
			},
			onDetachedExit: (postExit) => {
				recoveredResult = postExit as RunSyncResult;
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(fs.existsSync(outputPath), false);

		for (let attempt = 0; attempt < 100 && (!fs.existsSync(outputPath) || !recoveredResult); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		assert.equal(fs.readFileSync(outputPath, "utf-8"), "after reply");
		assert.ok(recoveredResult);
		assert.equal(recoveredResult.exitCode, 0);
		assert.equal(recoveredResult.progress?.status, "completed");
		assert.equal(recoveredResult.savedOutputPath, outputPath);
		assert.equal(recoveredResult.outputSaveError, undefined);
		assert.match(recoveredResult.finalOutput ?? "", /^Output saved to:/);
	});

	it("aborts a foreground coordination tool start instead of detaching without a delivered handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 10000, jsonl: [events.assistantMessage("after abort")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controller = new AbortController();
		let aborted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "contact-supervisor-abort-without-handoff",
			allowIntercomDetach: true,
			signal: controller.signal,
			onUpdate: (update) => {
				if (aborted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				aborted = true;
				controller.abort();
			},
		});

		assert.equal(aborted, true);
		assert.notEqual(result.exitCode, -2);
		assert.equal(result.detached, undefined);
		assert.notEqual(result.progress?.status, "detached");
	});

	for (const testCase of [
		{ name: "intercom ask", toolName: "intercom", args: { action: "ask", to: "orchestrator" } },
		{ name: "contact_supervisor need_decision", toolName: "contact_supervisor", args: { reason: "need_decision", message: "Need a decision" } },
		{ name: "contact_supervisor interview_request", toolName: "contact_supervisor", args: { reason: "interview_request", message: "Need input", interview: { questions: [] } } },
	]) {
		it(`does not detach foreground children on blocking ${testCase.name} before a delivered handoff`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ delay: 50, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-blocking-detach`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "received pong");
			assert.equal(result.progress?.status, "completed");
		});
	}

	for (const testCase of [
		{ name: "intercom send", toolName: "intercom", args: { action: "send", to: "orchestrator", message: "FYI" } },
		{ name: "contact_supervisor progress_update", toolName: "contact_supervisor", args: { reason: "progress_update", message: "FYI" } },
	]) {
		it(`does not proactively detach foreground children on non-blocking ${testCase.name}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ jsonl: [events.toolEnd(testCase.toolName)] },
					{ jsonl: [events.assistantMessage("done")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-nonblocking`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "done");
			assert.equal(result.progress?.status, "completed");
		});
	}

	it("lets an active intercom child accept detach when another child is listening", async () => {
		const eventBus = createEventBus();
		let firstDetachResponse: boolean | undefined;
		eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			if ((payload as { requestId?: unknown }).requestId !== "parallel-request") return;
			firstDetachResponse ??= (payload as { accepted?: unknown }).accepted === true;
		});
		mockPi.onCall({ delay: 500, output: "quiet child done" });
		const agents = makeAgentConfigs(["quiet", "intercom"]);

		const quietRun = runSync(tempDir, agents, "quiet", "Quiet task", {
			runId: "quiet-listener",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
		});
		for (let attempt = 0; attempt < 50 && mockPi.callCount() < 1; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(mockPi.callCount(), 1);
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 500, jsonl: [events.assistantMessage("after intercom")] },
			],
		});

		let detachEmitted = false;
		const intercomRun = runSync(tempDir, agents, "intercom", "Intercom task", {
			runId: "active-intercom",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				const sawIntercom = Array.isArray(progress) && progress.some((p) => p?.currentTool === "intercom");
				if (!sawIntercom) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-request" });
			},
		});

		const [quietResult, intercomResult] = await Promise.all([quietRun, intercomRun]);

		assert.equal(quietResult.exitCode, 0);
		assert.equal(quietResult.detached, undefined);
		assert.equal(intercomResult.exitCode, -2);
		assert.equal(intercomResult.detached, true);
		assert.equal(firstDetachResponse, true);
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

});
