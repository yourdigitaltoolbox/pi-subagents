export const RELAY_RUNNER_DELEGATION_ENV = "PI_SUBAGENT_RELAY_RUNNER_DELEGATION";
export const RELAY_RUNNER_SOCKET_ENV = "PI_SUBAGENT_RELAY_RUNNER_SOCKET";
const RELAY_EXPOSURE_CAPABILITY_ENV = "PI_SUBAGENT_RELAY_EXPOSURE_CAPABILITY";

export interface ConsumedRelayRunnerEnvironment {
	token: string;
	socketPath: string;
}

/**
 * First operation in the detached runner entrypoint. Authority is copied into
 * lexical process memory, then removed before the large runner module (or any
 * child process) is loaded. A partial pair is unusable and fails local-only.
 */
export function consumeRelayRunnerEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): ConsumedRelayRunnerEnvironment | undefined {
	const token = env[RELAY_RUNNER_DELEGATION_ENV];
	const socketPath = env[RELAY_RUNNER_SOCKET_ENV];
	delete env[RELAY_RUNNER_DELEGATION_ENV];
	delete env[RELAY_RUNNER_SOCKET_ENV];
	delete env[RELAY_EXPOSURE_CAPABILITY_ENV];
	return token && socketPath ? { token, socketPath } : undefined;
}
