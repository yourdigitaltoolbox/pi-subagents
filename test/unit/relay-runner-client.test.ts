import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { createRelayRunnerClient } from "../../src/runs/background/relay-runner-client.ts";

const token = `rprd1.44444444-4444-4444-8444-444444444444.${"a".repeat(43)}`;
const binding = {
	runId: "run-async",
	workspaceId: "11111111-1111-4111-8111-111111111111",
	agentId: "22222222-2222-4222-8222-222222222222",
	processEpoch: "33333333-3333-4333-8333-333333333333",
	mode: "relay" as const,
};
const lease = {
	relayExposureLeaseId: "55555555-5555-4555-8555-555555555555",
	parent: {
		workspaceId: binding.workspaceId,
		agentId: "66666666-6666-4666-8666-666666666666",
		processEpoch: "77777777-7777-4777-8777-777777777777",
	},
	binding,
	issuedAt: Date.now(),
	expiresAt: Date.now() + 30_000,
};

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(handler: (request: Record<string, unknown>, socket: Socket) => void): Promise<string> {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-runner-client-"));
	dirs.push(dir);
	const socketPath = process.platform === "win32"
		? `\\\\.\\pipe\\pi-runner-client-${randomUUID()}`
		: path.join(dir, "broker.sock");
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			handler(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>, socket);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return socketPath;
}

describe("relay runner strict local IPC client", () => {
	it("issues and lifecycles one exact lease without exposing the token in results", async () => {
		const observed: Record<string, unknown>[] = [];
		const socketPath = await serve((request, socket) => {
			observed.push(request);
			const base = { type: "relay_runner_result", version: 1, requestId: request.requestId, ok: true };
			const response = request.type === "relay_runner_issue"
				? { ...base, state: "issued", capability: `rpel1.${lease.relayExposureLeaseId}.${"b".repeat(43)}`, lease }
				: request.type === "relay_runner_renew"
					? { ...base, state: "renewed", lease: { ...lease, expiresAt: lease.expiresAt + 10_000 } }
					: request.type === "relay_runner_close"
						? { ...base, state: "closed", lease }
						: { ...base, state: "released" };
			socket.end(`${JSON.stringify(response)}\n`);
		});
		const client = createRelayRunnerClient({ token, socketPath, timeoutMs: 100 });
		const issued = await client.issue(binding, 30_000, "fallback");
		assert.equal(issued.ok, true);
		if (!issued.ok) return;
		const renewed = await client.renew(issued.lease, 30_000, "88888888-8888-4888-8888-888888888888");
		assert.equal(renewed.ok, true);
		assert.equal((await client.close(issued.lease, "completed")).ok, true);
		assert.deepEqual(await client.release(), { ok: true, state: "released" });
		assert.deepEqual(observed.map((request) => request.type), [
			"relay_runner_issue", "relay_runner_renew", "relay_runner_close", "relay_runner_release",
		]);
		assert.ok(observed.every((request) => request.token === token));
		assert.equal(observed[0]?.intentSource, "fallback");
		assert.equal(JSON.stringify([issued, renewed]).includes(token), false);
	});

	it("rejects unknown response fields and never reflects bearer bytes", async () => {
		const socketPath = await serve((request, socket) => socket.end(`${JSON.stringify({
			type: "relay_runner_result",
			version: 1,
			requestId: request.requestId,
			ok: false,
			reason: "invalid_runner_delegation",
			workloadId: token,
		})}\n`));
		const result = await createRelayRunnerClient({ token, socketPath, timeoutMs: 100 }).issue(binding, 30_000, "run");
		assert.deepEqual(result, { ok: false, reason: "invalid_reply" });
		assert.equal(JSON.stringify(result).includes(token), false);
	});
});
