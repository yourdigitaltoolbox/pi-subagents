import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	loadForegroundResumeRuns,
	persistForegroundResumeRuns,
} from "../../src/runs/shared/foreground-run-state.ts";
import type { ForegroundResumeRun } from "../../src/shared/types.ts";

const roots: string[] = [];
function tempFile(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "foreground-run-state-"));
	roots.push(root);
	return path.join(root, "foreground-runs.json");
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("foreground resume state", () => {
	it("round-trips only minimal secret-free revive identity", () => {
		const file = tempFile();
		const run: ForegroundResumeRun = {
			runId: "run-1234",
			mode: "single",
			cwd: "/workspace",
			updatedAt: 100,
			children: [{
				agent: "worker",
				index: 0,
				status: "completed",
				workspaceId: "11111111-1111-4111-8111-111111111111",
				agentId: "22222222-2222-4222-8222-222222222222",
				requestedExposure: "relay",
				requestedExposureSource: "run",
				sessionFile: "/sessions/run-1234/session.jsonl",
				updatedAt: 100,
				finalOutput: "must not persist",
				artifactPaths: {
					inputPath: "/secret/input",
					outputPath: "/secret/output",
					jsonlPath: "/secret/raw",
					transcriptPath: "/secret/transcript",
					metadataPath: "/secret/meta",
				},
			}],
		};

		persistForegroundResumeRuns(file, new Map([[run.runId, run]]));
		const bytes = fs.readFileSync(file, "utf8");
		assert.doesNotMatch(bytes, /must not persist|artifactPaths|processEpoch|capability/i);
		assert.deepEqual(loadForegroundResumeRuns(file).get(run.runId), {
			runId: run.runId,
			mode: run.mode,
			cwd: run.cwd,
			updatedAt: run.updatedAt,
			children: [{
				agent: "worker",
				index: 0,
				status: "completed",
				workspaceId: "11111111-1111-4111-8111-111111111111",
				agentId: "22222222-2222-4222-8222-222222222222",
				requestedExposure: "relay",
				requestedExposureSource: "run",
				sessionFile: "/sessions/run-1234/session.jsonl",
				updatedAt: 100,
			}],
		});
	});

	it("rejects a corrupt or partially identified ledger as a whole", () => {
		const file = tempFile();
		fs.writeFileSync(file, JSON.stringify({
			version: 1,
			runs: [{
				runId: "run-1234",
				mode: "single",
				cwd: "/workspace",
				updatedAt: 100,
				children: [{
					agent: "worker",
					index: 0,
					status: "completed",
					workspaceId: "11111111-1111-4111-8111-111111111111",
					sessionFile: "/sessions/run-1234/session.jsonl",
				}],
			}],
		}), "utf8");
		assert.equal(loadForegroundResumeRuns(file).size, 0);

		fs.writeFileSync(file, JSON.stringify({
			version: 1,
			runs: [{
				runId: "run-exposure",
				mode: "single",
				cwd: "/workspace",
				updatedAt: 100,
				children: [{ agent: "worker", index: 0, status: "completed", requestedExposure: "relay" }],
			}],
		}), "utf8");
		assert.equal(loadForegroundResumeRuns(file).size, 0, "partial exposure intent must fail closed");
	});
});
