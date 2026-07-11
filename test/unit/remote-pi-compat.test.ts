import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	preflightRemotePiCompatibility,
	type RemotePiPreflightOptions,
} from "../../src/runs/shared/remote-pi-compat.ts";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; agentDir: string; projectDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-remote-compat-"));
	tempRoots.push(root);
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	return { root, agentDir, projectDir };
}

function writeJson(filePath: string, value: unknown): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const raw = `${JSON.stringify(value, null, 2)}\n`;
	fs.writeFileSync(filePath, raw, "utf8");
	return raw;
}

function options(agentDir: string, projectDir: string, candidatePackageJsonPaths: string[] = []): RemotePiPreflightOptions {
	return {
		agentDir,
		cwd: projectDir,
		candidatePackageJsonPaths,
		resolvePackageJson: () => undefined,
	};
}

describe("remote-pi compatibility preflight", () => {
	it("allows child launch when remote-pi is absent", () => {
		const { agentDir, projectDir } = fixture();
		assert.deepEqual(preflightRemotePiCompatibility(options(agentDir, projectDir)), { state: "absent" });
	});

	it("expands a tilde PI_CODING_AGENT_DIR before reading settings and manifests", () => {
		const { root, projectDir } = fixture();
		const homeDir = path.join(root, "home");
		const agentDir = path.join(homeDir, ".pi", "agent");
		writeJson(path.join(agentDir, "settings.json"), { packages: ["npm:remote-pi@0.5.4"] });
		writeJson(path.join(agentDir, "npm", "node_modules", "remote-pi", "package.json"), {
			name: "remote-pi",
			version: "0.5.4",
			pi: { remotePi: { childSessionProtocol: { current: 1, supported: [1], descriptorEnv: "PI_SUBAGENT_DESCRIPTOR" } } },
		});
		const result = preflightRemotePiCompatibility({
			agentDir: "~/.pi/agent",
			homeDir,
			cwd: projectDir,
			resolvePackageJson: () => undefined,
		});
		assert.equal(result.state, "compatible");
	});

	it("accepts a declared remote-pi that explicitly supports the launcher protocol", () => {
		const { root, agentDir, projectDir } = fixture();
		writeJson(path.join(agentDir, "settings.json"), { packages: ["npm:remote-pi@0.5.4"] });
		const packagePath = path.join(root, "remote-pi", "package.json");
		const raw = writeJson(packagePath, {
			name: "remote-pi",
			version: "0.5.4",
			pi: {
				remotePi: {
					childSessionProtocol: { current: 1, supported: [1], descriptorEnv: "PI_SUBAGENT_DESCRIPTOR" },
				},
			},
		});

		assert.deepEqual(
			preflightRemotePiCompatibility(options(agentDir, projectDir, [packagePath])),
			{
				state: "compatible",
				version: "0.5.4",
				protocolVersion: 1,
				manifestSha256: createHash("sha256").update(raw).digest("hex"),
				sourceSpec: "npm:remote-pi@0.5.4",
			},
		);
	});

	it("resolves a relative local remote_pi source from the declaring settings directory", () => {
		const { agentDir, projectDir } = fixture();
		writeJson(path.join(agentDir, "settings.json"), { packages: ["../checkout/remote_pi"] });
		const packagePath = path.resolve(agentDir, "../checkout/remote_pi/pi-extension/package.json");
		writeJson(packagePath, {
			name: "remote-pi",
			version: "0.5.4",
			pi: { remotePi: { childSessionProtocol: { current: 1, supported: [1], descriptorEnv: "PI_SUBAGENT_DESCRIPTOR" } } },
		});
		const result = preflightRemotePiCompatibility({
			agentDir,
			cwd: projectDir,
			resolvePackageJson: () => undefined,
		});
		assert.equal(result.state, "compatible");
		if (result.state === "compatible") assert.equal(result.sourceSpec, "../checkout/remote_pi");
	});

	it("accepts a newer remote-pi only when it advertises current protocol support", () => {
		const { root, agentDir, projectDir } = fixture();
		writeJson(path.join(projectDir, ".pi", "settings.json"), { packages: ["npm:remote-pi@0.6.0"] });
		const packagePath = path.join(root, "remote-pi", "package.json");
		writeJson(packagePath, {
			name: "remote-pi",
			version: "0.6.0",
			pi: { remotePi: { childSessionProtocol: { current: 2, supported: [1, 2], descriptorEnv: "PI_SUBAGENT_DESCRIPTOR" } } },
		});
		const result = preflightRemotePiCompatibility(options(agentDir, projectDir, [packagePath]));
		assert.equal(result.state, "compatible");
		if (result.state === "compatible") assert.equal(result.protocolVersion, 1);
	});

	it("blocks declared old remote-pi before child wake when protocol metadata is absent", () => {
		const { root, agentDir, projectDir } = fixture();
		writeJson(path.join(agentDir, "settings.json"), { packages: ["npm:remote-pi@0.5.4"] });
		const packagePath = path.join(root, "remote-pi", "package.json");
		writeJson(packagePath, { name: "remote-pi", version: "0.5.4", pi: { extensions: ["./dist/index.js"] } });
		assert.throws(
			() => preflightRemotePiCompatibility(options(agentDir, projectDir, [packagePath])),
			/error: remote-pi@0\.5\.4 does not declare child-session protocol compatibility/i,
		);
	});

	it("blocks a declared remote-pi whose manifest cannot be resolved", () => {
		const { agentDir, projectDir } = fixture();
		writeJson(path.join(agentDir, "settings.json"), { packages: ["git:github.com/example/remote_pi#deadbeef"] });
		assert.throws(
			() => preflightRemotePiCompatibility(options(agentDir, projectDir)),
			/declares remote-pi.*manifest could not be resolved/i,
		);
	});

	it("ignores unrelated package manifests and fails closed for unsupported/future-only protocols", () => {
		const { root, agentDir, projectDir } = fixture();
		writeJson(path.join(agentDir, "settings.json"), { packages: ["npm:remote-pi@0.7.0"] });
		const unrelated = path.join(root, "unrelated", "package.json");
		writeJson(unrelated, { name: "other-extension", version: "1.0.0" });
		const remote = path.join(root, "remote", "package.json");
		writeJson(remote, {
			name: "remote-pi",
			version: "0.7.0",
			pi: { remotePi: { childSessionProtocol: { current: 2, supported: [2], descriptorEnv: "PI_SUBAGENT_DESCRIPTOR" } } },
		});
		assert.throws(
			() => preflightRemotePiCompatibility(options(agentDir, projectDir, [unrelated, remote])),
			/does not support child-session protocol v1/i,
		);
	});
});
