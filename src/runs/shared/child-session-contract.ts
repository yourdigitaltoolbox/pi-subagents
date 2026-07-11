import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CHILD_SESSION_DESCRIPTOR_ENV = "PI_SUBAGENT_DESCRIPTOR";
export const CHILD_SESSION_PROTOCOL_VERSION = 1 as const;

export type ChildExposureMode = "off" | "local" | "relay";

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

export interface ChildSessionDescriptorV1 {
	version: 1;
	kind: "pi-subagent-child";
	sessionClass: "child";
	runId: string;
	agentId: string;
	processEpoch: string;
	parentSessionId?: string;
	parentAgentId?: string;
	index: number;
	requestedExposure: ChildExposureMode;
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
	requestedExposure?: ChildExposureMode;
	processEpoch?: string;
	producer: PackageIdentity;
	remotePi: RemotePiCompatibilityDescriptor;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const EXPOSURE_MODES = new Set<ChildExposureMode>(["off", "local", "relay"]);

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
		agentId: stableChildAgentId(runId, childAgentName, childIndex),
		processEpoch: processEpoch.toLowerCase(),
		...(input.parentSessionId !== undefined
			? { parentSessionId: requireNonEmpty(input.parentSessionId, "parentSessionId") }
			: {}),
		...(input.parentAgentId !== undefined
			? { parentAgentId: requireNonEmpty(input.parentAgentId, "parentAgentId") }
			: {}),
		index: childIndex,
		requestedExposure,
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
