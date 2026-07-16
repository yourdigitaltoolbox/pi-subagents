import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const tempRoots: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const auditScript = path.join(repoRoot, "skills/cost-aware-model-routing/scripts/audit-session-costs.mjs");

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function assistantRecord(id: string, model: string, toolName: string, usage: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "message",
		id: `message-${id}`,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			responseId: id,
			model,
			content: [{ type: "toolCall", name: toolName, arguments: {} }],
			usage,
		},
	};
}

function writeJsonl(filePath: string, records: Record<string, unknown>[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

describe("cost-aware model routing audit", () => {
	it("deduplicates copied responses and derives effective prices without reading prompts", () => {
		const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-cost-audit-"));
		tempRoots.push(sessionsDir);
		const luna = assistantRecord("response-luna", "gpt-5.6-luna", "read", {
			input: 1_000,
			output: 100,
			cacheRead: 2_000,
			cacheWrite: 0,
			reasoning: 10,
			cost: { input: 0.001, output: 0.0006, cacheRead: 0.0002, cacheWrite: 0, total: 0.0018 },
		});
		const terra = assistantRecord("response-terra", "gpt-5.6-terra", "edit", {
			input: 2_000,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 20,
			cost: { input: 0.005, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.008 },
		});
		const noUsage = assistantRecord("response-no-usage", "gpt-5.6-sol", "bash", {});
		delete (noUsage.message as Record<string, unknown>).usage;
		writeJsonl(path.join(sessionsDir, "parent.jsonl"), [luna, terra, noUsage]);
		writeJsonl(path.join(sessionsDir, "fork", "session.jsonl"), [luna]);

		const output = execFileSync(process.execPath, [auditScript, "--days", "1", "--sessions-dir", sessionsDir, "--format", "json"], { encoding: "utf8" });
		const report = JSON.parse(output);

		assert.equal(report.assistantRecordsSeen, 4);
		assert.equal(report.recordsSeen, 3);
		assert.equal(report.uniqueResponses, 2);
		assert.equal(report.duplicateRecords, 1);
		assert.equal(report.total.turns, 2);
		assert.equal(report.total.cost, 0.0098);
		assert.equal(report.actionClasses["read/recon"].turns, 1);
		assert.equal(report.actionClasses["mutation/edit-write"].turns, 1);
		assert.equal(report.effectivePrices["gpt-5.6-luna"].input, 1);
		assert.equal(report.effectivePrices["gpt-5.6-luna"].output, 6);
		assert.equal(report.effectivePrices["gpt-5.6-luna"].cacheRead, 0.1);
		assert.equal(report.effectivePrices["gpt-5.6-terra"].input, 2.5);
		assert.equal(report.effectivePrices["gpt-5.6-terra"].output, 15);
	});
});
