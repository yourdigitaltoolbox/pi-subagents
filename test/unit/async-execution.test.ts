import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerEnv, buildAsyncRunnerSteps, resolveAsyncRunnerLogPaths } from "../../src/runs/background/async-execution.ts";
import {
	RELAY_EXPOSURE_CAPABILITY_ENV,
	RELAY_RUNNER_DELEGATION_ENV,
	RELAY_RUNNER_SOCKET_ENV,
} from "../../src/runs/shared/relay-exposure.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const agent = (name: string, toolBudget?: AgentConfig["toolBudget"], exposure?: AgentConfig["exposure"]): AgentConfig => ({
	name,
	description: `${name} agent`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: `${name}.md`,
	...(toolBudget ? { toolBudget } : {}),
	...(exposure ? { exposure } : {}),
});

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: undefined,
	currentModelProvider: undefined,
	modelScope: undefined,
};

describe("async runner execution", () => {
	it("places detached runner stdio logs in the async run directory", () => {
		const asyncDir = path.join("tmp", "async-run");
		assert.deepEqual(resolveAsyncRunnerLogPaths({ asyncDir }), {
			stdoutPath: path.join(asyncDir, "runner.stdout.log"),
			stderrPath: path.join(asyncDir, "runner.stderr.log"),
		});
	});

	it("omits runner log paths when asyncDir is unavailable", () => {
		assert.equal(resolveAsyncRunnerLogPaths({}), undefined);
	});

	it("passes runner delegation only in trusted runner env and scrubs inherited child bearers", () => {
		const inherited = {
			SAFE: "value",
			[RELAY_EXPOSURE_CAPABILITY_ENV]: "old-child-capability",
			[RELAY_RUNNER_DELEGATION_ENV]: "old-runner-token",
			[RELAY_RUNNER_SOCKET_ENV]: "/tmp/old.sock",
		};
		const token = `rprd1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
		const env = buildAsyncRunnerEnv(inherited, {
			token,
			socketPath: "/tmp/current.sock",
			expiresAt: Date.now() + 60_000,
			maxLeaseTtlMs: 30_000,
			maxChildIssues: 4,
		});
		assert.equal(env.SAFE, "value");
		assert.equal(env[RELAY_EXPOSURE_CAPABILITY_ENV], "");
		assert.equal(env[RELAY_RUNNER_DELEGATION_ENV], token);
		assert.equal(env[RELAY_RUNNER_SOCKET_ENV], "/tmp/current.sock");
		const localOnly = buildAsyncRunnerEnv(inherited);
		assert.equal(localOnly[RELAY_EXPOSURE_CAPABILITY_ENV], "");
		assert.equal(localOnly[RELAY_RUNNER_DELEGATION_ENV], "");
		assert.equal(localOnly[RELAY_RUNNER_SOCKET_ENV], "");
	});

	it("resolves async step tool budgets with step over run over agent over config precedence", () => {
		const result = buildAsyncRunnerSteps("run-1", {
			chain: [
				{ agent: "worker", task: "agent beats config" },
				{ agent: "worker", task: "step beats run", toolBudget: { hard: 2, block: ["grep"] } },
			],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			toolBudget: { hard: 3, block: ["find"] },
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 3, block: ["find"] });
		assert.deepEqual(result.steps[1]?.toolBudget, { hard: 2, block: ["grep"] });
	});

	it("uses agent tool budget before config default when no run override exists", () => {
		const result = buildAsyncRunnerSteps("run-2", {
			chain: [{ agent: "worker", task: "agent beats config" }],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 4, block: ["read"] });
	});

	it("propagates resolved agent exposure through sequential and parallel runner steps", () => {
		const result = buildAsyncRunnerSteps("run-exposure", {
			chain: [
				{ agent: "worker", task: "sequential" },
				{ parallel: [{ agent: "worker", task: "parallel" }] },
			],
			agents: [agent("worker", undefined, "off")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.equal(result.steps[0]?.requestedExposure, "off");
		const parallel = result.steps[1];
		assert.ok(parallel && "parallel" in parallel && Array.isArray(parallel.parallel));
		if (parallel && "parallel" in parallel && Array.isArray(parallel.parallel)) {
			assert.equal(parallel.parallel[0]?.requestedExposure, "off");
		}
	});

	it("shares one workspaceId across children while allocating distinct agentIds", () => {
		const workspaceId = "11111111-1111-4111-8111-111111111111";
		const result = buildAsyncRunnerSteps("run-identity", {
			workspaceId,
			chain: [
				{ agent: "worker", task: "one" },
				{ parallel: [{ agent: "worker", task: "two" }, { agent: "worker", task: "three" }] },
			],
			agents: [agent("worker")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
		});

		assert.ok("steps" in result, "expected successful step build");
		const identities = result.steps.flatMap((step) => "parallel" in step && Array.isArray(step.parallel)
			? step.parallel.map((child) => child.childIdentity)
			: [step.childIdentity]);
		assert.equal(identities.length, 3);
		assert.deepEqual(new Set(identities.map((identity) => identity?.workspaceId)), new Set([workspaceId]));
		assert.equal(new Set(identities.map((identity) => identity?.agentId)).size, 3);
	});

	it("uses config default when no step, run, or agent budget exists", () => {
		const result = buildAsyncRunnerSteps("run-3", {
			chain: [{ agent: "worker", task: "config default" }],
			agents: [agent("worker")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 5, block: ["ls"] });
	});
});
