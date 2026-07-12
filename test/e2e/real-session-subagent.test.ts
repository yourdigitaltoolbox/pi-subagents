/**
 * Real Pi-session end-to-end test for the subagent extension.
 *
 * Spawns an actual child `pi` subprocess (a repo-local child CLI that runs a
 * real `AgentSession` backed by a faux provider) and exercises the extension's
 * real foreground execution path: the parent session calls the `subagent` tool,
 * the tool spawns the child, the child streams jsonl events, the extension's
 * real stdout parser extracts the result, and the marker flows back as a tool
 * result that the parent relays. No real API keys are used.
 *
 * Skips gracefully when the pi runtime packages are not importable.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { tryImport } from "../support/helpers.ts";
import type { RealSessionRun } from "../support/real-session-runner.ts";

const piCodingAgent = await tryImport<unknown>("@earendil-works/pi-coding-agent");
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);

const CHILD_MARKER = "CHILD_REAL_SESSION_OK";
// Env vars the runner must clear so a parent that was itself spawned as a
// subagent child can still launch fresh children. The values are deliberately
// bogus sentinels (nonexistent paths) so a leaked value would break spawning.
const BOGUS_EXTRA_DIRS = path.join(os.tmpdir(), "nonexistent-pi-subagents-e2e-extra-dirs");
const BOGUS_PI_BINARY = path.join(os.tmpdir(), "nonexistent-pi-binary-e2e");
const BOGUS_PI_PACKAGE_ROOT = path.join(os.tmpdir(), "nonexistent-pi-coding-agent-package-root-e2e");
const ISOLATED_ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_FANOUT_CHILD",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_PI_BINARY",
	"PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
] as const;

describe("real Pi-session subagent E2E", { skip: !available ? "pi runtime packages not available" : undefined }, () => {
	let run: RealSessionRun | undefined;

	afterEach(async () => {
		await run?.dispose();
		run = undefined;
	});

	it("boots the extension in a real parent session and delivers a faux child result", async () => {
		const { routeParentThroughSubagent, runRealSubagentSession, subagentToolResults } = await import("../support/real-session-runner.ts");

		const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "1";
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = BOGUS_EXTRA_DIRS;
		process.env.PI_SUBAGENT_PARENT_SESSION = "polluted-parent";
		process.env.PI_SUBAGENT_PI_BINARY = BOGUS_PI_BINARY;
		process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = BOGUS_PI_PACKAGE_ROOT;

		try {
			run = await runRealSubagentSession({
				prompt: "Delegate to a worker and report its exact result.",
				childText: CHILD_MARKER,
				respond: routeParentThroughSubagent({
					childMarker: CHILD_MARKER,
					subagentArgs: {
						agent: "worker",
						task: "Return the marker from the faux child provider.",
						context: "fresh",
						agentScope: "project",
					},
				}),
			});

			const toolResults = subagentToolResults(run.parentSession);
			assert.ok(run.modelCalls >= 1, `expected the parent model to run; calls: ${run.modelCalls}`);
			assert.equal(toolResults.length, 1, `expected parent to call subagent; response was: ${run.responseText}; model calls: ${run.modelCalls}`);
			assert.match(toolResults[0]!, new RegExp(CHILD_MARKER));
			assert.match(run.responseText, new RegExp(CHILD_MARKER));
			assert.doesNotMatch(run.responseText, /CHILD_MISSING/);
			assert.ok(run.modelCalls >= 2, `expected parent tool-call and final turns, got ${run.modelCalls}`);
		} finally {
			await run?.dispose();
			run = undefined;
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("preserves quota across reload and renews it only after Pi emits session_compact", async () => {
		const { runRealSubagentSession, subagentCall, subagentToolResults } = await import("../support/real-session-runner.ts");
		const subagentArgs = {
			agent: "worker",
			task: "Return the marker from the faux child provider.",
			context: "fresh",
			agentScope: "project",
		};
		run = await runRealSubagentSession({
			prompt: "Run the first worker.",
			childText: CHILD_MARKER,
			subagentConfig: { maxSubagentSpawnsPerSession: 1 },
			respond: (context, state) => {
				const isParent = (context.tools ?? []).some((tool) => tool.name === "subagent");
				if (!isParent) return "Unexpected non-parent model call.";
				if (state.callCount === 1 || state.callCount === 3 || state.callCount === 5) return subagentCall(subagentArgs, `call-${state.callCount}`);
				return "Parent completed its current turn.";
			},
		});
		const first = subagentToolResults(run.parentSession);
		assert.equal(first.length, 1);
		assert.match(first[0]!, new RegExp(CHILD_MARKER));

		await run.parentSession.reload();
		const retainedQuota = (globalThis as Record<string, unknown>).__piSubagentSpawnQuotaBySession;
		assert.ok(retainedQuota instanceof Map, "reload must retain the process-local quota registry");
		assert.deepEqual([...retainedQuota.values()].map((entry) => (entry as { count: number }).count), [1]);
		await run.parentSession.prompt("Try a second worker after reload but before compaction.", { expandPromptTemplates: false });
		const beforeCompact = subagentToolResults(run.parentSession);
		assert.equal(beforeCompact.length, 2);
		assert.match(beforeCompact[1]!, /spawn limit reached/i);

		await run.parentSession.extensionRunner.emit({ type: "session_compact", reason: "manual" });
		await run.parentSession.prompt("Run a worker after successful compaction.", { expandPromptTemplates: false });
		const afterCompact = subagentToolResults(run.parentSession);
		assert.equal(afterCompact.length, 3);
		assert.match(afterCompact[2]!, new RegExp(CHILD_MARKER));
	});
});
