import { consumeRelayRunnerEnvironment } from "../shared/relay-runner-env.ts";

// This must run before dynamically importing the large runner module: no
// transitive module gets an opportunity to inspect or persist runner authority.
const authority = consumeRelayRunnerEnvironment(process.env);

try {
	const { startSubagentRunnerFromCommandLine } = await import("./subagent-runner.ts");
	await startSubagentRunnerFromCommandLine(authority);
} catch (error) {
	// Runner/client errors are designed never to include bearer bytes.
	console.error("Subagent runner error:", error);
	process.exit(1);
}
