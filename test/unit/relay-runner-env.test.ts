import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	consumeRelayRunnerEnvironment,
	RELAY_RUNNER_DELEGATION_ENV,
	RELAY_RUNNER_SOCKET_ENV,
} from "../../src/runs/shared/relay-runner-env.ts";

const CAPABILITY_ENV = "PI_SUBAGENT_RELAY_EXPOSURE_CAPABILITY";

describe("relay runner environment custody", () => {
	it("snapshots the exact pair and deletes every relay bearer before runner imports", () => {
		const env: NodeJS.ProcessEnv = {
			[RELAY_RUNNER_DELEGATION_ENV]: "runner-secret",
			[RELAY_RUNNER_SOCKET_ENV]: "/tmp/broker.sock",
			[CAPABILITY_ENV]: "child-secret",
		};
		assert.deepEqual(consumeRelayRunnerEnvironment(env), {
			token: "runner-secret",
			socketPath: "/tmp/broker.sock",
		});
		assert.equal(env[RELAY_RUNNER_DELEGATION_ENV], undefined);
		assert.equal(env[RELAY_RUNNER_SOCKET_ENV], undefined);
		assert.equal(env[CAPABILITY_ENV], undefined);
	});

	it("deletes partial authority and returns local-only", () => {
		const env: NodeJS.ProcessEnv = { [RELAY_RUNNER_DELEGATION_ENV]: "runner-secret" };
		assert.equal(consumeRelayRunnerEnvironment(env), undefined);
		assert.equal(env[RELAY_RUNNER_DELEGATION_ENV], undefined);
		assert.equal(env[RELAY_RUNNER_SOCKET_ENV], undefined);
	});
});
