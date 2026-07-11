import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { ForegroundResumeChild, ForegroundResumeRun } from "../../shared/types.ts";
import { validateChildRuntimeIdentity } from "./child-session-contract.ts";

const FOREGROUND_RUN_STATE_VERSION = 1;
export const FOREGROUND_RUN_STATE_FILE = "foreground-runs.json";
const MAX_STORED_RUNS = 50;
const RUN_MODES = new Set(["single", "parallel", "chain"]);
const CHILD_STATUSES = new Set(["completed", "failed", "paused", "stopped", "detached"]);

interface StoredForegroundRunState {
	version: typeof FOREGROUND_RUN_STATE_VERSION;
	runs: ForegroundResumeRun[];
}

function finiteTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function parseChild(value: unknown): ForegroundResumeChild | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const agent = boundedString(raw.agent, 256);
	const index = raw.index;
	const status = raw.status;
	if (!agent || !Number.isInteger(index) || (index as number) < 0 || !CHILD_STATUSES.has(status as string)) return undefined;
	if ((raw.workspaceId === undefined) !== (raw.agentId === undefined)) return undefined;
	let identity: { workspaceId: string; agentId: string } | undefined;
	if (raw.workspaceId !== undefined && raw.agentId !== undefined) {
		try {
			identity = validateChildRuntimeIdentity({ workspaceId: raw.workspaceId, agentId: raw.agentId });
		} catch {
			return undefined;
		}
	}
	const sessionFile = raw.sessionFile === undefined ? undefined : boundedString(raw.sessionFile, 4096);
	if (raw.sessionFile !== undefined && (!sessionFile || !path.isAbsolute(sessionFile) || path.extname(sessionFile) !== ".jsonl")) return undefined;
	const updatedAt = raw.updatedAt === undefined ? undefined : finiteTimestamp(raw.updatedAt);
	if (raw.updatedAt !== undefined && updatedAt === undefined) return undefined;
	const exitCode = raw.exitCode === undefined
		? undefined
		: typeof raw.exitCode === "number" && Number.isFinite(raw.exitCode) ? raw.exitCode : undefined;
	if (raw.exitCode !== undefined && exitCode === undefined) return undefined;
	return {
		agent,
		index: index as number,
		status: status as ForegroundResumeChild["status"],
		...(identity ?? {}),
		...(sessionFile ? { sessionFile } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
	};
}

function parseRun(value: unknown): ForegroundResumeRun | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const runId = boundedString(raw.runId, 256);
	const cwd = boundedString(raw.cwd, 4096);
	const mode = raw.mode;
	const updatedAt = finiteTimestamp(raw.updatedAt);
	if (!runId || !cwd || !path.isAbsolute(cwd) || !RUN_MODES.has(mode as string) || updatedAt === undefined || !Array.isArray(raw.children)) return undefined;
	const children = raw.children.map(parseChild);
	if (children.some((child) => child === undefined)) return undefined;
	return {
		runId,
		mode: mode as ForegroundResumeRun["mode"],
		cwd,
		updatedAt,
		children: children as ForegroundResumeChild[],
	};
}

/**
 * Load the minimal foreground-resume ledger associated with one parent Pi
 * session. The ledger intentionally excludes task text, model output,
 * capabilities, and process epochs; it retains only routing identity and the
 * child session file required for an explicit revive.
 */
export function loadForegroundResumeRuns(filePath: string): Map<string, ForegroundResumeRun> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return new Map();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== FOREGROUND_RUN_STATE_VERSION || !Array.isArray(raw.runs)) return new Map();
	const runs = raw.runs.map(parseRun);
	if (runs.some((run) => run === undefined)) return new Map();
	return new Map((runs as ForegroundResumeRun[]).slice(-MAX_STORED_RUNS).map((run) => [run.runId, run]));
}

function minimalRun(run: ForegroundResumeRun): ForegroundResumeRun {
	return {
		runId: run.runId,
		mode: run.mode,
		cwd: run.cwd,
		updatedAt: run.updatedAt,
		children: run.children.map((child) => ({
			agent: child.agent,
			index: child.index,
			status: child.status,
			...(child.workspaceId && child.agentId ? { workspaceId: child.workspaceId, agentId: child.agentId } : {}),
			...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
			...(child.updatedAt !== undefined ? { updatedAt: child.updatedAt } : {}),
			...(child.exitCode !== undefined ? { exitCode: child.exitCode } : {}),
		})),
	};
}

export function persistForegroundResumeRuns(filePath: string, runs: Map<string, ForegroundResumeRun>): void {
	const payload: StoredForegroundRunState = {
		version: FOREGROUND_RUN_STATE_VERSION,
		runs: [...runs.values()]
			.sort((left, right) => left.updatedAt - right.updatedAt)
			.slice(-MAX_STORED_RUNS)
			.map(minimalRun),
	};
	writeAtomicJson(filePath, payload);
}
