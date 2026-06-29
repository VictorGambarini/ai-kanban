import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { isLocalHostId, LOCAL_HOST_ID, proxyHttpRequest, readHostIdFromRequest } from "../../../src/hosts/host-proxy";

function makeRequest(headers: Record<string, string>, url = "/api/trpc/x"): IncomingMessage {
	return { headers, url } as unknown as IncomingMessage;
}

describe("readHostIdFromRequest", () => {
	it("defaults to the local sentinel when no host is specified", () => {
		const req = makeRequest({});
		expect(readHostIdFromRequest(req, new URL("http://localhost/api/trpc/x"))).toBe(LOCAL_HOST_ID);
		expect(isLocalHostId(LOCAL_HOST_ID)).toBe(true);
	});

	it("reads the host id from the header", () => {
		const req = makeRequest({ "x-kanban-host-id": "van-one" });
		expect(readHostIdFromRequest(req, new URL("http://localhost/x"))).toBe("van-one");
	});

	it("falls back to the hostId query parameter", () => {
		const req = makeRequest({});
		expect(readHostIdFromRequest(req, new URL("http://localhost/api/terminal/io?hostId=van-two"))).toBe("van-two");
	});
});

describe("proxyHttpRequest", () => {
	const servers: Server[] = [];

	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
		);
	});

	function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
		const server = createServer(handler);
		servers.push(server);
		return new Promise((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
		});
	}

	it("rewrites Host and Origin to the remote runtime port, not the forwarded port", async () => {
		let seenHost: string | undefined;
		let seenOrigin: string | undefined;
		let seenUrl: string | undefined;
		// The upstream listens on a random forwarded port, but the remote's Host
		// AND Origin allowlists only accept its own runtime port — so both headers
		// must carry the runtime port, not the connect port. Use a distinct runtime
		// port here so a regression (reusing the connect port) is caught.
		const forwardedPort = await startServer((req, res) => {
			seenHost = req.headers.host;
			seenOrigin = req.headers.origin;
			seenUrl = req.url;
			res.writeHead(200, { "Content-Type": "application/json", "x-upstream": "yes" });
			res.end(JSON.stringify({ ok: true }));
		});
		const runtimePort = 3484;

		const proxyPort = await startServer((req, res) => {
			proxyHttpRequest(req, res, forwardedPort, runtimePort);
		});

		// Send an Origin like a browser would, pointing at the hub's (different) port.
		const response = await fetch(`http://127.0.0.1:${proxyPort}/api/trpc/projects.list`, {
			headers: { origin: `http://127.0.0.1:${proxyPort}` },
		});
		const body = (await response.json()) as { ok: boolean };

		expect(response.status).toBe(200);
		expect(response.headers.get("x-upstream")).toBe("yes");
		expect(body.ok).toBe(true);
		expect(seenUrl).toBe("/api/trpc/projects.list");
		// Host and Origin must be the runtime port, NOT the forwarded/connect port.
		expect(seenHost).toBe(`127.0.0.1:${runtimePort}`);
		expect(seenHost).not.toBe(`127.0.0.1:${forwardedPort}`);
		expect(seenOrigin).toBe(`http://127.0.0.1:${runtimePort}`);
	});

	it("does not fabricate an Origin header when the client sent none", async () => {
		let hadOrigin = true;
		const forwardedPort = await startServer((req, res) => {
			hadOrigin = req.headers.origin !== undefined;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});

		const proxyPort = await startServer((req, res) => {
			proxyHttpRequest(req, res, forwardedPort, 3484);
		});

		await fetch(`http://127.0.0.1:${proxyPort}/api/passcode/status`);
		expect(hadOrigin).toBe(false);
	});

	it("returns 502 when the upstream is unreachable", async () => {
		// Port 1 is reserved and never listening on loopback.
		const proxyPort = await startServer((req, res) => {
			proxyHttpRequest(req, res, 1, 3484);
		});
		const response = await fetch(`http://127.0.0.1:${proxyPort}/api/trpc/x`);
		expect(response.status).toBe(502);
	});
});
