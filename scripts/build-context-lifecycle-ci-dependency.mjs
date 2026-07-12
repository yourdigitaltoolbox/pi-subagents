import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dependencyName = "@yourdigitaltoolbox/pi-context-lifecycle";
const dependencySpec = packageJson.dependencies?.[dependencyName];
const match = /^git\+(https:\/\/github\.com\/yourdigitaltoolbox\/pi-context-lifecycle\.git)#([0-9a-f]{40})$/.exec(
	dependencySpec ?? "",
);

if (!match) {
	throw new Error(`${dependencyName} must be pinned to an exact approved GitHub HTTPS SHA`);
}

const [, repositoryUrl, commit] = match;
const target = join(root, "node_modules", "@yourdigitaltoolbox", "pi-context-lifecycle");
const workspace = await mkdtemp(join(tmpdir(), "pi-context-lifecycle-ci-"));
const npmCli =
	process.platform === "win32"
		? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
		: join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js");

async function run(command, args, cwd) {
	await execFile(command, args, { cwd });
}

async function runNpm(args, cwd) {
	await stat(npmCli);
	await execFile(process.execPath, [npmCli, ...args], { cwd });
}

try {
	await run("git", ["clone", "--no-checkout", repositoryUrl, workspace], root);
	await run("git", ["checkout", "--detach", commit], workspace);
	const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: workspace });
	if (stdout.trim() !== commit) {
		throw new Error(`cloned lifecycle source resolved ${stdout.trim()}, expected ${commit}`);
	}

	// Keep the consumer install hardened: dependency lifecycle hooks remain disabled.
	// This is the only explicitly approved lifecycle build, at the immutable SHA above.
	await runNpm(["ci", "--ignore-scripts"], workspace);
	await runNpm(["run", "build"], workspace);

	for (const file of ["index.js", "extension.js", "testing/index.js"]) {
		await stat(join(workspace, "dist", file));
	}
	const installedPackage = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
	if (installedPackage.name !== dependencyName) {
		throw new Error(`installed dependency at ${target} is not ${dependencyName}`);
	}

	await rm(join(target, "dist"), { recursive: true, force: true });
	await cp(join(workspace, "dist"), join(target, "dist"), { recursive: true });
	console.log(`Built ${dependencyName} at exact commit ${commit} for hardened CI.`);
} finally {
	await rm(workspace, { recursive: true, force: true });
}
