import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	CHILD_SESSION_DESCRIPTOR_ENV,
	CHILD_SESSION_PROTOCOL_VERSION,
	createChildRuntimeIdentity,
	createChildSessionDescriptor,
	encodeChildSessionDescriptor,
	loadPiSubagentsPackageIdentity,
	resolveChildWorkspaceId,
	stableChildAgentId,
} from "../../src/runs/shared/child-session-contract.ts";

describe("child session contract", () => {
	it("loads the exact pi-subagents package identity used by the launcher", () => {
		const packagePath = new URL("../../package.json", import.meta.url);
		const raw = fs.readFileSync(packagePath, "utf8");
		assert.deepEqual(loadPiSubagentsPackageIdentity(), {
			name: "pi-subagents",
			version: "0.34.1",
			manifestSha256: createHash("sha256").update(raw).digest("hex"),
		});
	});

	it("builds a versioned non-authoritative descriptor with safe source diagnostics", () => {
		const descriptor = createChildSessionDescriptor({
			runId: "run-123",
			childAgentName: "reviewer",
			childIndex: 2,
			parentSessionId: "parent-session",
			parentAgentId: "parent-agent",
			requestedExposure: "local",
			intentSource: "agent",
			processEpoch: "22222222-2222-4222-8222-222222222222",
			producer: {
				name: "pi-subagents",
				version: "0.34.0",
				manifestSha256: "a".repeat(64),
			},
			remotePi: {
				state: "compatible",
				version: "0.5.4",
				protocolVersion: 1,
				manifestSha256: "b".repeat(64),
			},
		});

		assert.equal(CHILD_SESSION_DESCRIPTOR_ENV, "PI_SUBAGENT_DESCRIPTOR");
		assert.equal(descriptor.version, CHILD_SESSION_PROTOCOL_VERSION);
		assert.equal(descriptor.kind, "pi-subagent-child");
		assert.equal(descriptor.sessionClass, "child");
		assert.equal(descriptor.runId, "run-123");
		assert.equal(descriptor.agentId, stableChildAgentId("run-123", "reviewer", 2));
		assert.equal(descriptor.processEpoch, "22222222-2222-4222-8222-222222222222");
		assert.equal(descriptor.requestedExposure, "local");
		assert.equal(descriptor.intentSource, "agent");
		assert.deepEqual(descriptor.producer, {
			name: "pi-subagents",
			version: "0.34.0",
			protocolVersion: 1,
			manifestSha256: "a".repeat(64),
		});
		assert.deepEqual(descriptor.compatibility.remotePi, {
			state: "compatible",
			version: "0.5.4",
			protocolVersion: 1,
			manifestSha256: "b".repeat(64),
		});
		assert.deepEqual(JSON.parse(encodeChildSessionDescriptor(descriptor)), descriptor);
	});

	it("keeps supplied logical identity stable across rename/resume while rotating process epoch", () => {
		const identity = createChildRuntimeIdentity();
		const base = {
			runId: "run-stable",
			childAgentName: "worker",
			childIndex: 0,
			identity,
			producer: { name: "pi-subagents" as const, version: "0.34.0", manifestSha256: "c".repeat(64) },
			remotePi: { state: "absent" as const },
		};
		const first = createChildSessionDescriptor(base);
		const second = createChildSessionDescriptor({ ...base, runId: "revived-run", childAgentName: "renamed-worker" });
		assert.equal(first.workspaceId, identity.workspaceId);
		assert.equal(first.agentId, identity.agentId);
		assert.equal(second.workspaceId, identity.workspaceId);
		assert.equal(second.agentId, identity.agentId);
		assert.notEqual(first.processEpoch, second.processEpoch);
		assert.equal(first.intentSource, "fallback");
		assert.equal(second.intentSource, "fallback");
		assert.match(first.workspaceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.match(first.agentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.match(first.processEpoch, /^[0-9a-f-]{36}$/);
	});

	it("inherits one workspace ID from parent descriptor or protected cwd config", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-"));
		const configured = "11111111-1111-4111-8111-111111111111";
		const inherited = "22222222-2222-4222-8222-222222222222";
		try {
			const dir = path.join(cwd, ".pi", "remote-pi");
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.chmodSync(dir, 0o700);
			const configPath = path.join(dir, "config.json");
			fs.writeFileSync(configPath, JSON.stringify({ schema_version: 1, revision: 1, workspace_id: configured, child_exposure: "relay" }), { mode: 0o600 });
			fs.chmodSync(configPath, 0o600);
			assert.equal(resolveChildWorkspaceId(cwd, { descriptorJson: "" }), configured);
			assert.equal(resolveChildWorkspaceId(cwd, {
				descriptorJson: JSON.stringify({ version: 1, workspaceId: inherited }),
			}), inherited);
			const first = createChildRuntimeIdentity(configured, () => "33333333-3333-4333-8333-333333333333");
			const second = createChildRuntimeIdentity(configured, () => "44444444-4444-4444-8444-444444444444");
			assert.equal(first.workspaceId, second.workspaceId);
			assert.notEqual(first.agentId, second.agentId);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("inherits a supervisor-injected direct-config workspace ID", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-"));
		const previous = process.env["REMOTE_PI_DIRECT_CONFIG"];
		try {
			process.env["REMOTE_PI_DIRECT_CONFIG"] = JSON.stringify({ workspace_id: "55555555-5555-4555-8555-555555555555" });
			assert.equal(resolveChildWorkspaceId(cwd, { descriptorJson: "", parentSessionId: "parent-direct" }), "55555555-5555-4555-8555-555555555555");
		} finally {
			if (previous === undefined) delete process.env["REMOTE_PI_DIRECT_CONFIG"];
			else process.env["REMOTE_PI_DIRECT_CONFIG"] = previous;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not trust a workspace ID from an unprotected config", { skip: process.platform === "win32" }, () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-"));
		try {
			const dir = path.join(cwd, ".pi", "remote-pi");
			fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
			const configPath = path.join(dir, "config.json");
			fs.writeFileSync(configPath, JSON.stringify({ schema_version: 1, revision: 1, workspace_id: "11111111-1111-4111-8111-111111111111" }), { mode: 0o644 });
			if (process.platform !== "win32") {
				fs.chmodSync(dir, 0o755);
				fs.chmodSync(configPath, 0o644);
			}
			const resolved = resolveChildWorkspaceId(cwd, { descriptorJson: "", parentSessionId: "parent-protected" });
			assert.notEqual(resolved, "11111111-1111-4111-8111-111111111111");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not trust a protected config through a symlinked workspace root", { skip: process.platform === "win32" }, () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-target-"));
		const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-alias-"));
		const alias = path.join(aliasParent, "workspace");
		const configured = "11111111-1111-4111-8111-111111111111";
		try {
			const dir = path.join(target, ".pi", "remote-pi");
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.chmodSync(dir, 0o700);
			const configPath = path.join(dir, "config.json");
			fs.writeFileSync(configPath, JSON.stringify({ schema_version: 1, revision: 1, workspace_id: configured }), { mode: 0o600 });
			fs.chmodSync(configPath, 0o600);
			fs.symlinkSync(target, alias);

			const resolved = resolveChildWorkspaceId(alias, { descriptorJson: "", parentSessionId: "parent-symlink-root" });
			assert.notEqual(resolved, configured);
			assert.equal(resolved, stableChildAgentId("parent-symlink-root", "workspace", 0));
		} finally {
			fs.rmSync(aliasParent, { recursive: true, force: true });
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	it("uses a stable parent-session fallback without mutating missing config", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-"));
		try {
			const first = resolveChildWorkspaceId(cwd, { descriptorJson: "", parentSessionId: "parent-1" });
			const second = resolveChildWorkspaceId(cwd, { descriptorJson: "", parentSessionId: "parent-1" });
			assert.equal(first, second);
			assert.equal(fs.existsSync(path.join(cwd, ".pi", "remote-pi", "config.json")), false);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects empty identifiers and invalid exposure rather than emitting an ambiguous claim", () => {
		const base = {
			runId: "run",
			childAgentName: "worker",
			childIndex: 0,
			producer: { name: "pi-subagents" as const, version: "0.34.0", manifestSha256: "d".repeat(64) },
			remotePi: { state: "absent" as const },
		};
		assert.throws(() => createChildSessionDescriptor({ ...base, runId: " " }), /runId/);
		assert.throws(() => createChildSessionDescriptor({ ...base, childAgentName: "" }), /childAgentName/);
		assert.throws(
			() => createChildSessionDescriptor({ ...base, requestedExposure: "phone" as "local" }),
			/requestedExposure/,
		);
	});
});
