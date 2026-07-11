import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CHILD_SESSION_DESCRIPTOR_ENV = "PI_SUBAGENT_DESCRIPTOR";
export const CHILD_SESSION_PROTOCOL_VERSION = 1 as const;

export type ChildExposureMode = "off" | "local" | "relay";
export type ChildExposureIntentSource = "run" | "agent" | "fallback";

export interface PackageIdentity {
	name: "pi-subagents";
	version: string;
	manifestSha256: string;
}

export interface LoadPackageIdentityOptions {
	packageJsonPath?: string;
	readFile?: (filePath: string) => string;
}

export type RemotePiCompatibilityDescriptor =
	| { state: "absent" }
	| {
		state: "compatible";
		version: string;
		protocolVersion: 1;
		manifestSha256: string;
	};

export interface ChildRuntimeIdentity {
	workspaceId: string;
	agentId: string;
}

export interface ChildSessionDescriptorV1 {
	version: 1;
	kind: "pi-subagent-child";
	sessionClass: "child";
	runId: string;
	workspaceId: string;
	agentId: string;
	processEpoch: string;
	parentSessionId?: string;
	parentAgentId?: string;
	index: number;
	requestedExposure: ChildExposureMode;
	intentSource: ChildExposureIntentSource;
	producer: PackageIdentity & { protocolVersion: 1 };
	compatibility: {
		remotePi: RemotePiCompatibilityDescriptor;
	};
}

export interface CreateChildSessionDescriptorInput {
	runId: string;
	childAgentName: string;
	childIndex?: number;
	parentSessionId?: string;
	parentAgentId?: string;
	identity?: ChildRuntimeIdentity;
	requestedExposure?: ChildExposureMode;
	intentSource?: ChildExposureIntentSource;
	processEpoch?: string;
	producer: PackageIdentity;
	remotePi: RemotePiCompatibilityDescriptor;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const EXPOSURE_MODES = new Set<ChildExposureMode>(["off", "local", "relay"]);
const INTENT_SOURCES = new Set<ChildExposureIntentSource>(["run", "agent", "fallback"]);

export function createChildRuntimeIdentity(workspaceId = randomUUID(), generateUuid: () => string = randomUUID): ChildRuntimeIdentity {
	return validateChildRuntimeIdentity({ workspaceId, agentId: generateUuid() });
}

export interface ResolveChildWorkspaceIdOptions {
	parentSessionId?: string;
	descriptorJson?: string;
	generateUuid?: () => string;
}

function workspaceIdFromParentDescriptor(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const workspaceId = parsed?.["workspaceId"];
		return typeof workspaceId === "string" && UUID_PATTERN.test(workspaceId)
			? workspaceId.toLowerCase()
			: undefined;
	} catch {
		return undefined;
	}
}

function workspaceIdFromDirectConfig(): string | undefined {
	const raw = process.env["REMOTE_PI_DIRECT_CONFIG"];
	if (!raw?.trim()) return undefined;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		const workspaceId = value?.["workspace_id"];
		return typeof workspaceId === "string" && UUID_PATTERN.test(workspaceId)
			? workspaceId.toLowerCase()
			: undefined;
	} catch {
		return undefined;
	}
}

// Bind reads to opened objects and reject a symlink in the final component.
// Explicit checks cover existing ancestor symlinks. A malicious process already
// running as this same OS user remains outside the protected-config threat
// boundary because portable Node has no openat2-style contained resolution.
function protectedReadFlags(base: number): number {
	return base | fs.constants.O_NOFOLLOW;
}

function workspaceIdFromProtectedConfig(cwd: string): string | undefined {
	const root = path.resolve(cwd);
	const configPath = path.join(root, ".pi", "remote-pi", "config.json");
	const configDir = path.dirname(configPath);
	for (const candidate of [root, path.join(root, ".pi"), configDir, configPath]) {
		try {
			const stat = fs.lstatSync(candidate);
			if (stat.isSymbolicLink()) return undefined;
			if (candidate !== configPath && process.platform !== "win32") {
				const getuid = process.getuid;
				if ((stat.mode & 0o022) !== 0) return undefined;
				if (typeof getuid === "function" && stat.uid !== getuid()) return undefined;
			}
		} catch {
			return undefined;
		}
	}
	let dirFd: number | undefined;
	let fileFd: number | undefined;
	try {
		dirFd = fs.openSync(configDir, protectedReadFlags(fs.constants.O_RDONLY | fs.constants.O_DIRECTORY));
		fileFd = fs.openSync(configPath, protectedReadFlags(fs.constants.O_RDONLY));
		const dirStat = fs.fstatSync(dirFd);
		const fileStat = fs.fstatSync(fileFd);
		if (!dirStat.isDirectory() || !fileStat.isFile()) return undefined;
		if (process.platform !== "win32") {
			const getuid = process.getuid;
			if ((dirStat.mode & 0o777) !== 0o700 || (fileStat.mode & 0o777) !== 0o600) return undefined;
			if (typeof getuid === "function" && (dirStat.uid !== getuid() || fileStat.uid !== getuid())) return undefined;
		}
		// Parse bytes from the same opened object whose protection metadata was
		// validated above. A later pathname replacement cannot redirect this read.
		const raw = fs.readFileSync(fileFd, "utf8");
		const namedDir = fs.lstatSync(configDir);
		const namedFile = fs.lstatSync(configPath);
		if (namedDir.isSymbolicLink() || namedFile.isSymbolicLink()
			|| namedDir.dev !== dirStat.dev || namedDir.ino !== dirStat.ino
			|| namedFile.dev !== fileStat.dev || namedFile.ino !== fileStat.ino) return undefined;
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const allowedKeys = new Set(["schema_version", "revision", "workspace_id", "agent_name", "auto_start_relay", "child_exposure"]);
		if (Object.keys(parsed).some((key) => !allowedKeys.has(key) || /(secret|token|capability|credential|password|nonce|lease)/i.test(key))) return undefined;
		if (parsed["agent_name"] !== undefined && typeof parsed["agent_name"] !== "string") return undefined;
		if (parsed["auto_start_relay"] !== undefined && typeof parsed["auto_start_relay"] !== "boolean") return undefined;
		if (parsed["child_exposure"] !== undefined
			&& parsed["child_exposure"] !== "off"
			&& parsed["child_exposure"] !== "local"
			&& parsed["child_exposure"] !== "relay") return undefined;
		const rawName = parsed["agent_name"];
		if (typeof rawName === "string" && (!rawName.trim() || /[\\/]/.test(rawName) || /#\d+$/.test(rawName) || /[\u0000-\u001f\u007f]/.test(rawName))) return undefined;
		const revision = parsed["revision"];
		const workspaceId = parsed["workspace_id"];
		return parsed["schema_version"] === 1
			&& Number.isInteger(revision)
			&& (revision as number) >= 1
			&& typeof workspaceId === "string"
			&& UUID_PATTERN.test(workspaceId)
			? workspaceId.toLowerCase()
			: undefined;
	} catch {
		return undefined;
	} finally {
		if (fileFd !== undefined) fs.closeSync(fileFd);
		if (dirFd !== undefined) fs.closeSync(dirFd);
	}
}

/**
 * Resolve one non-secret workspace correlation ID for all children of a parent
 * workspace. Nested children inherit their parent descriptor. Top-level runs
 * reuse remote-pi's protected workspace ID when present; otherwise Pi's stable
 * parent session ID yields a deterministic fallback. This function never
 * creates or mutates remote-pi configuration.
 */
export function resolveChildWorkspaceId(cwd: string, options: ResolveChildWorkspaceIdOptions = {}): string {
	const inherited = workspaceIdFromParentDescriptor(options.descriptorJson ?? process.env[CHILD_SESSION_DESCRIPTOR_ENV]);
	if (inherited) return inherited;
	const injected = workspaceIdFromDirectConfig();
	if (injected) return injected;
	const configured = workspaceIdFromProtectedConfig(cwd);
	if (configured) return configured;
	if (options.parentSessionId?.trim()) {
		return stableChildAgentId(options.parentSessionId.trim(), "workspace", 0);
	}
	return validateChildRuntimeIdentity({
		workspaceId: (options.generateUuid ?? randomUUID)(),
		agentId: randomUUID(),
	}).workspaceId;
}

export function validateChildWorkspaceId(workspaceId: string): string {
	if (!UUID_PATTERN.test(workspaceId)) throw new Error("Child session identity.workspaceId must be a UUID.");
	return workspaceId.toLowerCase();
}

export function validateChildRuntimeIdentity(identity: ChildRuntimeIdentity): ChildRuntimeIdentity {
	if (!identity || typeof identity !== "object") throw new Error("Child session identity is required.");
	const workspaceId = validateChildWorkspaceId(identity.workspaceId);
	if (!UUID_PATTERN.test(identity.agentId)) throw new Error("Child session identity.agentId must be a UUID.");
	return { workspaceId, agentId: identity.agentId.toLowerCase() };
}

function requireNonEmpty(value: string | undefined, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Child session ${name} must be a non-empty string.`);
	}
	return value.trim();
}

function requireManifestHash(value: string, name: string): string {
	if (!SHA256_PATTERN.test(value)) {
		throw new Error(`Child session ${name} must be a lowercase SHA-256 hex digest.`);
	}
	return value.toLowerCase();
}

export function loadPiSubagentsPackageIdentity(options: LoadPackageIdentityOptions = {}): PackageIdentity {
	const packageJsonPath = options.packageJsonPath
		?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
	const raw = (options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8")))(packageJsonPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot parse pi-subagents package manifest '${packageJsonPath}': ${detail}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Pi-subagents package manifest '${packageJsonPath}' must be an object.`);
	}
	const pkg = parsed as Record<string, unknown>;
	if (pkg["name"] !== "pi-subagents" || typeof pkg["version"] !== "string" || pkg["version"].trim().length === 0) {
		throw new Error(`Package manifest '${packageJsonPath}' is not a versioned pi-subagents package.`);
	}
	return {
		name: "pi-subagents",
		version: pkg["version"].trim(),
		manifestSha256: createHash("sha256").update(raw).digest("hex"),
	};
}

/**
 * Produce a deterministic UUIDv5-shaped correlation id for one logical child
 * within a run. This identifier is non-authoritative and is not a credential.
 */
export function stableChildAgentId(runId: string, childAgentName: string, childIndex = 0): string {
	const normalizedRunId = requireNonEmpty(runId, "runId");
	const normalizedAgentName = requireNonEmpty(childAgentName, "childAgentName");
	if (!Number.isInteger(childIndex) || childIndex < 0) {
		throw new Error("Child session childIndex must be a non-negative integer.");
	}
	const bytes = createHash("sha256")
		.update("pi-subagents-child-agent-id-v1\0")
		.update(normalizedRunId)
		.update("\0")
		.update(normalizedAgentName)
		.update("\0")
		.update(String(childIndex))
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createChildSessionDescriptor(input: CreateChildSessionDescriptorInput): ChildSessionDescriptorV1 {
	const runId = requireNonEmpty(input.runId, "runId");
	const childAgentName = requireNonEmpty(input.childAgentName, "childAgentName");
	const childIndex = input.childIndex ?? 0;
	if (!Number.isInteger(childIndex) || childIndex < 0) {
		throw new Error("Child session childIndex must be a non-negative integer.");
	}
	const requestedExposure = input.requestedExposure ?? "local";
	if (!EXPOSURE_MODES.has(requestedExposure)) {
		throw new Error("Child session requestedExposure must be off, local, or relay.");
	}
	const intentSource = input.intentSource ?? "fallback";
	if (!INTENT_SOURCES.has(intentSource)) {
		throw new Error("Child session intentSource must be run, agent, or fallback.");
	}
	const fallbackAgentId = stableChildAgentId(runId, childAgentName, childIndex);
	const identity = validateChildRuntimeIdentity(input.identity ?? {
		workspaceId: stableChildAgentId(runId, "workspace", 0),
		agentId: fallbackAgentId,
	});
	const processEpoch = input.processEpoch ?? randomUUID();
	if (!UUID_PATTERN.test(processEpoch)) {
		throw new Error("Child session processEpoch must be a UUID.");
	}
	const producerVersion = requireNonEmpty(input.producer.version, "producer.version");
	if (input.producer.name !== "pi-subagents") {
		throw new Error("Child session producer.name must be pi-subagents.");
	}

	const remotePi = input.remotePi.state === "absent"
		? input.remotePi
		: {
			state: "compatible" as const,
			version: requireNonEmpty(input.remotePi.version, "compatibility.remotePi.version"),
			protocolVersion: CHILD_SESSION_PROTOCOL_VERSION,
			manifestSha256: requireManifestHash(input.remotePi.manifestSha256, "compatibility.remotePi.manifestSha256"),
		};

	return {
		version: CHILD_SESSION_PROTOCOL_VERSION,
		kind: "pi-subagent-child",
		sessionClass: "child",
		runId,
		workspaceId: identity.workspaceId,
		agentId: identity.agentId,
		processEpoch: processEpoch.toLowerCase(),
		...(input.parentSessionId !== undefined
			? { parentSessionId: requireNonEmpty(input.parentSessionId, "parentSessionId") }
			: {}),
		...(input.parentAgentId !== undefined
			? { parentAgentId: requireNonEmpty(input.parentAgentId, "parentAgentId") }
			: {}),
		index: childIndex,
		requestedExposure,
		intentSource,
		producer: {
			name: "pi-subagents",
			version: producerVersion,
			protocolVersion: CHILD_SESSION_PROTOCOL_VERSION,
			manifestSha256: requireManifestHash(input.producer.manifestSha256, "producer.manifestSha256"),
		},
		compatibility: { remotePi },
	};
}

export function encodeChildSessionDescriptor(descriptor: ChildSessionDescriptorV1): string {
	return JSON.stringify(descriptor);
}
