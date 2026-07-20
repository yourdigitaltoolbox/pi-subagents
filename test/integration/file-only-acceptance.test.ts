import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { executeAsyncSingle, isAsyncAvailable } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { createMockPi, createTempDir, makeAgent, makeAgentConfigs, removeTempDir } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";

// The mock harness otherwise auto-appends a valid report whenever it sees an
// acceptance contract. This unclosed marker suppresses that harness behavior
// without being a parseable acceptance-report block itself.
const INLINE_ONLY = "Review complete; report was written to the configured file.\n```acceptance-report";
const INLINE_ACCEPTANCE = "Review complete inline.";

function validReport(): string {
	return [
		"# Reviewer report",
		"Verdict: APPROVE",
		"",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "review completed" }],
			reviewFindings: [],
			notes: "file-only report",
		}),
		"```",
	].join("\n");
}

function malformedReport(): string {
	return "# Reviewer report\n```acceptance-report\n{not-json\n```\n";
}

async function waitForMockSpawn(mockPi: MockPi, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (mockPi.callCount() === 0) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for mock Pi spawn.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function writeAfterSnapshot(mockPi: MockPi, outputPath: string, contents: string): Promise<void> {
	await waitForMockSpawn(mockPi);
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, contents, "utf8");
}

async function waitForAsyncResult(id: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for async result: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
}

describe("file-only acceptance", () => {
	let mockPi: MockPi;
	let tempDir: string;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});
	after(() => mockPi.uninstall());
	beforeEach(() => {
		tempDir = createTempDir("pi-subagents-file-only-acceptance-");
		mockPi.reset();
	});
	afterEach(() => removeTempDir(tempDir));

	it("attests a foreground explicit reviewer acceptance report written only to the configured file", async () => {
		const outputPath = path.join(tempDir, "foreground-review.md");
		mockPi.onCall({ delay: 150, output: INLINE_ONLY });
		const writeReport = writeAfterSnapshot(mockPi, outputPath, validReport());

		const result = await runSync(tempDir, makeAgentConfigs(["ydtb-reviewer"]), "ydtb-reviewer", "Review only.", {
			outputPath,
			outputMode: "file-only",
			acceptance: { level: "attested" },
		});
		await writeReport;

		assert.equal(result.exitCode, 0);
		assert.equal(result.acceptance?.status, "attested");
		assert.equal(fs.readFileSync(outputPath, "utf8"), validReport());
	});

	it("attests a background explicit reviewer acceptance report written only to the configured file", { skip: !isAsyncAvailable() ? "async runner unavailable" : undefined }, async () => {
		const id = `issue136-file-only-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "background-review.md");
		mockPi.onCall({ delay: 150, output: INLINE_ONLY });
		const writeReport = writeAfterSnapshot(mockPi, outputPath, validReport());
		try {
			executeAsyncSingle(id, {
				agent: "ydtb-reviewer",
				task: "Review only.",
				agentConfig: makeAgent("ydtb-reviewer"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "issue136-test" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				output: outputPath,
				outputMode: "file-only",
				acceptance: { level: "attested" },
				maxSubagentDepth: 2,
			});
			await writeReport;
			const payload = await waitForAsyncResult(id);
			const [result] = payload.results as Array<{ success?: boolean; acceptance?: { status?: string } }>;
			assert.equal(payload.success, true);
			assert.equal(result?.success, true);
			assert.equal(result?.acceptance?.status, "attested");
			assert.equal(fs.readFileSync(outputPath, "utf8"), validReport());
		} finally {
			fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
			fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
		}
	});

	it("still rejects missing, malformed, and unchanged configured output without scanning another file", async (t) => {
		await t.test("missing configured file", async () => {
			const outputPath = path.join(tempDir, "missing.md");
			mockPi.onCall({ output: INLINE_ONLY });
			const result = await runSync(tempDir, makeAgentConfigs(["ydtb-reviewer"]), "ydtb-reviewer", "Review only.", {
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "attested" },
			});
			assert.equal(result.exitCode, 1);
			assert.equal(result.acceptance?.status, "rejected");
		});

		await t.test("runtime-persisted fallback retains valid inline acceptance without scanning another file", async () => {
			const outputPath = path.join(tempDir, "fallback.md");
			const unrelatedPath = path.join(tempDir, "unrelated-valid-report.md");
			fs.writeFileSync(unrelatedPath, validReport(), "utf8");
			mockPi.onCall({ output: INLINE_ACCEPTANCE });
			const result = await runSync(tempDir, makeAgentConfigs(["ydtb-reviewer"]), "ydtb-reviewer", "Review only.", {
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "attested" },
			});
			assert.equal(result.exitCode, 0);
			assert.equal(result.acceptance?.status, "attested");
			assert.equal(fs.readFileSync(outputPath, "utf8"), INLINE_ACCEPTANCE);
			assert.equal(fs.readFileSync(unrelatedPath, "utf8"), validReport());
		});

		await t.test("malformed changed configured file", async () => {
			const outputPath = path.join(tempDir, "malformed.md");
			mockPi.onCall({ delay: 150, output: INLINE_ONLY });
			const writeReport = writeAfterSnapshot(mockPi, outputPath, malformedReport());
			const result = await runSync(tempDir, makeAgentConfigs(["ydtb-reviewer"]), "ydtb-reviewer", "Review only.", {
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "attested" },
			});
			await writeReport;
			assert.equal(result.exitCode, 1);
			assert.equal(result.acceptance?.status, "rejected");
			assert.match(result.acceptance?.childReportParseError ?? "", /Failed to parse acceptance-report/);
		});

		await t.test("unchanged stale output and unrelated valid report", async () => {
			const outputPath = path.join(tempDir, "stale.md");
			const unrelatedPath = path.join(tempDir, "unrelated-valid-report.md");
			fs.writeFileSync(outputPath, validReport(), "utf8");
			fs.writeFileSync(unrelatedPath, validReport(), "utf8");
			mockPi.onCall({ output: INLINE_ONLY });
			const result = await runSync(tempDir, makeAgentConfigs(["ydtb-reviewer"]), "ydtb-reviewer", "Review only.", {
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "attested" },
			});
			assert.equal(result.exitCode, 1);
			assert.equal(result.acceptance?.status, "rejected");
			assert.equal(fs.readFileSync(outputPath, "utf8"), INLINE_ONLY);
			assert.equal(fs.readFileSync(unrelatedPath, "utf8"), validReport());
		});
	});
});
