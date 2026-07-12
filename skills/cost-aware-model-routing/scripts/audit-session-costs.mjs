#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

function usage() {
  console.error("Usage: audit-session-costs.mjs [--days N] [--sessions-dir PATH] [--format markdown|json]");
}

function parseArgs(argv) {
  const options = {
    days: 7,
    sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
    format: "markdown",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--days" && value) {
      options.days = Number(value);
      index += 1;
    } else if (arg === "--sessions-dir" && value) {
      options.sessionsDir = resolve(value);
      index += 1;
    } else if (arg === "--format" && value) {
      options.format = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error("--days must be a positive number");
  }
  if (!new Set(["markdown", "json"]).has(options.format)) {
    throw new Error("--format must be markdown or json");
  }
  return options;
}

async function* walkJsonl(root) {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

function emptyTotals() {
  return {
    turns: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    componentCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function addUsage(target, usage) {
  const cost = usage.cost ?? {};
  target.turns += 1;
  target.cost += Number(cost.total ?? 0);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
    target[key] += Number(usage[key] ?? 0);
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    target.componentCost[key] += Number(cost[key] ?? 0);
  }
}

function actionClass(content) {
  const calls = content.filter((item) => item?.type === "toolCall").map((item) => item.name);
  if (calls.some((name) => name === "edit" || name === "write")) return "mutation/edit-write";
  if (calls.some((name) => name === "subagent" || name === "create_pi_subagent")) return "orchestration/subagent";
  if (calls.some((name) => ["wait", "background_task_list", "background_task_details", "loop_timer", "list_peers", "agent_send", "update_chat_summary"].includes(name))) return "status/wait/coordination";
  if (calls.some((name) => ["read", "grep", "find", "ls"].includes(name))) return "read/recon";
  if (calls.includes("bash")) return "bash/test/admin";
  if (calls.length > 0) return "other-tool";
  return "text-only";
}

function asObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function effectivePrices(totals) {
  const result = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    result[key] = totals[key] > 0 ? (totals.componentCost[key] * 1_000_000) / totals[key] : null;
  }
  return result;
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

function integer(value) {
  return Math.round(value).toLocaleString("en-US");
}

function tableRows(groups) {
  return Object.entries(groups)
    .sort(([, left], [, right]) => right.cost - left.cost)
    .map(([name, totals]) => `| ${name} | ${integer(totals.turns)} | ${money(totals.cost)} | ${integer(totals.input)} | ${integer(totals.output)} | ${integer(totals.cacheRead)} |`)
    .join("\n");
}

function renderMarkdown(report) {
  return `# Pi Session Cost Audit

- Window: ${report.window.start} through ${report.window.end}
- Session directory: \`${report.sessionsDir}\`
- JSONL files scanned: ${integer(report.filesScanned)}
- Assistant records seen: ${integer(report.assistantRecordsSeen)}
- Assistant usage records seen: ${integer(report.recordsSeen)}
- Unique billed responses: ${integer(report.uniqueResponses)}
- Copied records removed: ${integer(report.duplicateRecords)}
- Recorded total cost: ${money(report.total.cost)}

## By model

| Model | Turns | Cost | Input | Output | Cache read |
|---|---:|---:|---:|---:|---:|
${tableRows(report.models)}

## Effective component prices per 1M tokens

| Model | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|
${Object.entries(report.effectivePrices).sort(([left], [right]) => left.localeCompare(right)).map(([name, prices]) => `| ${name} | ${prices.input === null ? "—" : money(prices.input)} | ${prices.output === null ? "—" : money(prices.output)} | ${prices.cacheRead === null ? "—" : money(prices.cacheRead)} | ${prices.cacheWrite === null ? "—" : money(prices.cacheWrite)} |`).join("\n")}

## By action class

| Action class | Turns | Cost | Input | Output | Cache read |
|---|---:|---:|---:|---:|---:|
${tableRows(report.actionClasses)}

## By UTC day

| Day | Turns | Cost | Input | Output | Cache read |
|---|---:|---:|---:|---:|---:|
${tableRows(report.days)}

The audit reads usage metadata and tool names only. It does not inspect prompt text or reasoning content. Responses copied into forked/resumed logs are deduplicated by response id, then message id.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const directoryStat = await stat(options.sessionsDir);
  if (!directoryStat.isDirectory()) throw new Error(`Not a directory: ${options.sessionsDir}`);

  const end = new Date();
  const start = new Date(end.getTime() - options.days * 24 * 60 * 60 * 1000);
  const seen = new Set();
  const models = new Map();
  const days = new Map();
  const actionClasses = new Map();
  const total = emptyTotals();
  let filesScanned = 0;
  let assistantRecordsSeen = 0;
  let recordsSeen = 0;
  let duplicateRecords = 0;

  for await (const file of walkJsonl(options.sessionsDir)) {
    filesScanned += 1;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const message = record?.message;
      if (message?.role !== "assistant") continue;
      const timestamp = new Date(record.timestamp ?? message.timestamp ?? 0);
      if (!Number.isFinite(timestamp.getTime()) || timestamp < start || timestamp > end) continue;
      assistantRecordsSeen += 1;
      if (!message.usage || typeof message.usage !== "object" || Array.isArray(message.usage)) continue;
      recordsSeen += 1;
      const responseKey = message.responseId ?? record.responseId ?? record.id ?? `${file}:${lineNumber}`;
      if (seen.has(responseKey)) {
        duplicateRecords += 1;
        continue;
      }
      seen.add(responseKey);
      const usage = message.usage ?? {};
      const model = message.model ?? "unknown";
      const day = timestamp.toISOString().slice(0, 10);
      const category = actionClass(Array.isArray(message.content) ? message.content : []);
      if (!models.has(model)) models.set(model, emptyTotals());
      if (!days.has(day)) days.set(day, emptyTotals());
      if (!actionClasses.has(category)) actionClasses.set(category, emptyTotals());
      addUsage(total, usage);
      addUsage(models.get(model), usage);
      addUsage(days.get(day), usage);
      addUsage(actionClasses.get(category), usage);
    }
  }

  const modelObject = asObject(models);
  const report = {
    schemaVersion: 1,
    generatedAt: end.toISOString(),
    sessionsDir: options.sessionsDir,
    window: { start: start.toISOString(), end: end.toISOString(), days: options.days },
    filesScanned,
    assistantRecordsSeen,
    recordsSeen,
    uniqueResponses: seen.size,
    duplicateRecords,
    total,
    models: modelObject,
    effectivePrices: Object.fromEntries(Object.entries(modelObject).map(([name, totals]) => [name, effectivePrices(totals)])),
    actionClasses: asObject(actionClasses),
    days: asObject(days),
  };

  process.stdout.write(options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
}

main().catch((error) => {
  console.error(`audit-session-costs: ${error.message}`);
  usage();
  process.exit(1);
});
