import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createChildSessionDescriptor } from "../../src/runs/shared/child-session-contract.ts";

interface Vector {
	case: string;
	environment: Record<string, string>;
	descriptor?: Record<string, unknown>;
	expected: Record<string, string>;
}

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "conformance", "child-session");

function readVector(name: string): Vector {
	return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")) as Vector;
}

describe("child-session conformance vectors", () => {
	it("matches the checked-in SHA-256 manifest", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8")) as {
			algorithm: string;
			files: Record<string, string>;
		};
		assert.equal(manifest.algorithm, "sha256");
		for (const [name, expected] of Object.entries(manifest.files)) {
			const actual = createHash("sha256").update(fs.readFileSync(path.join(fixtureDir, name))).digest("hex");
			assert.equal(actual, expected, `${name} fixture hash drifted`);
		}
	});

	it("emits the canonical current-v1 descriptor", () => {
		const vector = readVector("v1-current.json");
		const expected = vector.descriptor as any;
		const descriptor = createChildSessionDescriptor({
			runId: expected.runId,
			childAgentName: "fixture-reviewer",
			childIndex: expected.index,
			parentSessionId: expected.parentSessionId,
			parentAgentId: expected.parentAgentId,
			requestedExposure: expected.requestedExposure,
			processEpoch: expected.processEpoch,
			producer: {
				name: expected.producer.name,
				version: expected.producer.version,
				manifestSha256: expected.producer.manifestSha256,
			},
			remotePi: expected.compatibility.remotePi,
		});
		assert.deepEqual(descriptor, expected, "canonical vector must retain the exact descriptor shape");
	});

	it("keeps initial previous compatibility as the local-only legacy marker", () => {
		const legacy = readVector("legacy-v0.json");
		assert.deepEqual(legacy.environment, { PI_SUBAGENT_CHILD: "1" });
		assert.equal(legacy.expected.classification, "child_legacy");
		assert.equal(legacy.expected.mode, "local");
	});
});
