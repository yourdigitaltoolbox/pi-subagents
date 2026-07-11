import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import {
	CHILD_SESSION_DESCRIPTOR_ENV,
	CHILD_SESSION_PROTOCOL_VERSION,
	createChildSessionDescriptor,
	encodeChildSessionDescriptor,
	loadPiSubagentsPackageIdentity,
	stableChildAgentId,
} from "../../src/runs/shared/child-session-contract.ts";

describe("child session contract", () => {
	it("loads the exact pi-subagents package identity used by the launcher", () => {
		const packagePath = new URL("../../package.json", import.meta.url);
		const raw = fs.readFileSync(packagePath, "utf8");
		assert.deepEqual(loadPiSubagentsPackageIdentity(), {
			name: "pi-subagents",
			version: "0.34.0",
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

	it("keeps one logical agent id stable within a run while rotating process epoch", () => {
		const base = {
			runId: "run-stable",
			childAgentName: "worker",
			childIndex: 0,
			producer: { name: "pi-subagents" as const, version: "0.34.0", manifestSha256: "c".repeat(64) },
			remotePi: { state: "absent" as const },
		};
		const first = createChildSessionDescriptor(base);
		const second = createChildSessionDescriptor(base);
		assert.equal(first.agentId, second.agentId);
		assert.notEqual(first.processEpoch, second.processEpoch);
		assert.match(first.agentId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.match(first.processEpoch, /^[0-9a-f-]{36}$/);
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
