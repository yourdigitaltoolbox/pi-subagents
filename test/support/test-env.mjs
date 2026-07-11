import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Tests must never inherit the operator's live Pi package/settings graph. In
// particular, compatibility preflight is intentionally fail-closed for an old
// configured remote-pi, so every test process gets an isolated empty agent dir.
if (process.env.PI_SUBAGENTS_TEST_USE_REAL_SETTINGS !== "1") {
	// A test process may itself be launched as a pi-subagents child (for
	// example, an independent reviewer running the suite). Never let that
	// ambient parent/run/supervisor/capability identity classify test doubles
	// as live children or make test results depend on the caller's custody.
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("PI_SUBAGENT_")) delete process.env[name];
	}
	delete process.env.REMOTE_PI_DIRECT_CONFIG;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-home-"));
	delete process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.USERPROFILE = root;
	process.once("exit", () => {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// Test-process cleanup is best effort.
		}
	});
}
