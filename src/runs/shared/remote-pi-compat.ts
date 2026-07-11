import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHILD_SESSION_DESCRIPTOR_ENV,
	CHILD_SESSION_PROTOCOL_VERSION,
	type RemotePiCompatibilityDescriptor,
} from "./child-session-contract.ts";

export interface CompatibleRemotePi extends Extract<RemotePiCompatibilityDescriptor, { state: "compatible" }> {
	/** Exact settings package spec when remote-pi was explicitly configured. */
	sourceSpec?: string;
}

export type RemotePiCompatibility = { state: "absent" } | CompatibleRemotePi;

export interface RemotePiPreflightOptions {
	cwd?: string;
	agentDir?: string;
	settingsPaths?: string[];
	candidatePackageJsonPaths?: string[];
	resolvePackageJson?: () => string | undefined;
	readFile?: (filePath: string) => string;
	homeDir?: string;
}

interface RemotePiPackageManifest {
	name: "remote-pi";
	version: string;
	protocol: {
		current: number;
		supported: number[];
		descriptorEnv: string;
	};
	manifestSha256: string;
	path: string;
}

function readUtf8(filePath: string): string {
	return fs.readFileSync(filePath, "utf8");
}

function nearestProjectSettings(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".pi", "settings.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function defaultSettingsPaths(agentDir: string, cwd: string): string[] {
	const paths = [path.join(agentDir, "settings.json")];
	const projectSettings = nearestProjectSettings(cwd);
	if (projectSettings) paths.push(projectSettings);
	return paths;
}

function defaultCandidatePackageJsonPaths(agentDir: string, cwd: string): string[] {
	const paths = [path.join(agentDir, "npm", "node_modules", "remote-pi", "package.json")];
	const projectSettings = nearestProjectSettings(cwd);
	if (projectSettings) {
		paths.push(path.join(path.dirname(projectSettings), "npm", "node_modules", "remote-pi", "package.json"));
	}
	return paths;
}

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const value = entry as Record<string, unknown>;
	for (const key of ["source", "package", "spec", "path"]) {
		if (typeof value[key] === "string") return value[key] as string;
	}
	return undefined;
}

function isRemotePiSpec(spec: string): boolean {
	const normalized = spec.trim().replace(/\\/g, "/");
	return /(?:^|[/@:])remote[-_]pi(?:$|[/@#:])/i.test(normalized)
		|| /^npm:remote-pi(?:@|$)/i.test(normalized);
}

function configuredRemotePiSpecs(settingsPaths: string[], readFile: (filePath: string) => string): string[] {
	const specs: string[] = [];
	for (const settingsPath of settingsPaths) {
		if (!fs.existsSync(settingsPath)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFile(settingsPath)) as unknown;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Remote-pi compatibility error: cannot parse settings '${settingsPath}': ${detail}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const packages = (parsed as Record<string, unknown>)["packages"];
		if (!Array.isArray(packages)) continue;
		for (const entry of packages) {
			const spec = packageSource(entry);
			if (spec && isRemotePiSpec(spec)) specs.push(spec);
		}
	}
	return [...new Set(specs)];
}

function localSpecPackageJsonCandidates(specs: string[], settingsPaths: string[], agentDir: string, homeDir: string): string[] {
	const candidates: string[] = [];
	for (const spec of specs) {
		const raw = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
		if (/^(?:npm:|git:|github:|https?:|ssh:|git@)/i.test(raw)) continue;
		const expanded = raw === "~" ? homeDir : raw.startsWith("~/") ? path.join(homeDir, raw.slice(2)) : raw;
		const roots = path.isAbsolute(expanded)
			? [expanded]
			: [...settingsPaths.map((settingsPath) => path.resolve(path.dirname(settingsPath), expanded)), path.resolve(agentDir, expanded)];
		for (const root of roots) {
			candidates.push(path.join(root, "package.json"), path.join(root, "pi-extension", "package.json"));
		}
	}
	return candidates;
}

function findPackageJsonFromResolvedEntry(entryPath: string): string | undefined {
	let current = fs.statSync(entryPath).isDirectory() ? entryPath : path.dirname(entryPath);
	while (true) {
		const candidate = path.join(current, "package.json");
		if (fs.existsSync(candidate)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: unknown };
				if (parsed.name === "remote-pi") return candidate;
			} catch {
				// Keep walking; malformed manifests are diagnosed by explicit candidates.
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function defaultResolvePackageJson(): string | undefined {
	try {
		const resolved = import.meta.resolve("remote-pi/package.json");
		return fileURLToPath(resolved);
	} catch {
		try {
			const resolved = fileURLToPath(import.meta.resolve("remote-pi"));
			return findPackageJsonFromResolvedEntry(resolved);
		} catch {
			return undefined;
		}
	}
}

function parseRemotePiManifest(
	manifestPath: string,
	readFile: (filePath: string) => string,
): RemotePiPackageManifest | undefined {
	if (!fs.existsSync(manifestPath)) return undefined;
	let raw: string;
	let parsed: unknown;
	try {
		raw = readFile(manifestPath);
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Remote-pi compatibility error: cannot read package manifest '${manifestPath}': ${detail}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const pkg = parsed as Record<string, unknown>;
	if (pkg["name"] !== "remote-pi") return undefined;
	const version = pkg["version"];
	if (typeof version !== "string" || version.trim().length === 0) {
		throw new Error(`Remote-pi compatibility error: manifest '${manifestPath}' has no valid version.`);
	}
	const manifestSha256 = createHash("sha256").update(raw).digest("hex");
	const pi = pkg["pi"];
	const remotePi = pi && typeof pi === "object" && !Array.isArray(pi)
		? (pi as Record<string, unknown>)["remotePi"]
		: undefined;
	const protocol = remotePi && typeof remotePi === "object" && !Array.isArray(remotePi)
		? (remotePi as Record<string, unknown>)["childSessionProtocol"]
		: undefined;
	if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) {
		throw new Error(`Remote-pi compatibility error: remote-pi@${version} does not declare child-session protocol compatibility (manifest sha256 ${manifestSha256}).`);
	}
	const contract = protocol as Record<string, unknown>;
	const current = contract["current"];
	const supported = contract["supported"];
	const descriptorEnv = contract["descriptorEnv"];
	if (!Number.isInteger(current) || !Array.isArray(supported) || !supported.every(Number.isInteger) || typeof descriptorEnv !== "string") {
		throw new Error(`Remote-pi compatibility error: remote-pi@${version} has malformed child-session protocol metadata (manifest sha256 ${manifestSha256}).`);
	}
	return {
		name: "remote-pi",
		version,
		protocol: { current: current as number, supported: supported as number[], descriptorEnv },
		manifestSha256,
		path: manifestPath,
	};
}

/**
 * Fail before child Pi spawn when remote-pi is configured/resolvable but cannot
 * safely understand this launcher's descriptor. Absence is supported.
 */
export function preflightRemotePiCompatibility(options: RemotePiPreflightOptions = {}): RemotePiCompatibility {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? os.homedir();
	const configuredAgentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR;
	const agentDir = configuredAgentDir === "~"
		? homeDir
		: configuredAgentDir?.startsWith("~/")
			? path.join(homeDir, configuredAgentDir.slice(2))
			: configuredAgentDir ?? path.join(homeDir, ".pi", "agent");
	const readFile = options.readFile ?? readUtf8;
	const settingsPaths = options.settingsPaths ?? defaultSettingsPaths(agentDir, cwd);
	const configuredSpecs = configuredRemotePiSpecs(settingsPaths, readFile);
	const candidatePaths = [...(options.candidatePackageJsonPaths ?? [
		...defaultCandidatePackageJsonPaths(agentDir, cwd),
		...localSpecPackageJsonCandidates(configuredSpecs, settingsPaths, agentDir, homeDir),
	])];
	const resolvedPath = (options.resolvePackageJson ?? defaultResolvePackageJson)();
	if (resolvedPath) candidatePaths.push(resolvedPath);

	const manifests = [...new Set(candidatePaths.map((candidate) => path.resolve(candidate)))]
		.map((candidate) => parseRemotePiManifest(candidate, readFile))
		.filter((manifest): manifest is RemotePiPackageManifest => manifest !== undefined);

	if (manifests.length === 0) {
		if (configuredSpecs.length > 0) {
			throw new Error(`Remote-pi compatibility error: settings declares remote-pi (${configuredSpecs.join(", ")}) but its package manifest could not be resolved.`);
		}
		return { state: "absent" };
	}

	const distinctManifests = new Map(manifests.map((manifest) => [manifest.manifestSha256, manifest]));
	if (distinctManifests.size > 1) {
		const versions = [...distinctManifests.values()].map((manifest) => `${manifest.version}:${manifest.manifestSha256.slice(0, 12)}`);
		throw new Error(`Remote-pi compatibility error: multiple distinct remote-pi manifests were resolved (${versions.join(", ")}).`);
	}
	const manifest = manifests[0]!;
	if (manifest.protocol.descriptorEnv !== CHILD_SESSION_DESCRIPTOR_ENV) {
		throw new Error(`Remote-pi compatibility error: remote-pi@${manifest.version} expects descriptor env '${manifest.protocol.descriptorEnv}', not '${CHILD_SESSION_DESCRIPTOR_ENV}'.`);
	}
	if (!manifest.protocol.supported.includes(CHILD_SESSION_PROTOCOL_VERSION)) {
		throw new Error(`Remote-pi compatibility error: remote-pi@${manifest.version} does not support child-session protocol v${CHILD_SESSION_PROTOCOL_VERSION}.`);
	}

	return {
		state: "compatible",
		version: manifest.version,
		protocolVersion: CHILD_SESSION_PROTOCOL_VERSION,
		manifestSha256: manifest.manifestSha256,
		...(configuredSpecs[0] ? { sourceSpec: configuredSpecs[0] } : {}),
	};
}
