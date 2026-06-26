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

	it("forwards method, path, and rewritten host header, returning the upstream response", async () => {
		let seenHost: string | undefined;
		let seenUrl: string | undefined;
		const targetPort = await startServer((req, res) => {
			seenHost = req.headers.host;
			seenUrl = req.url;
			res.writeHead(200, { "Content-Type": "application/json", "x-upstream": "yes" });
			res.end(JSON.stringify({ ok: true }));
		});

		const proxyPort = await startServer((req, res) => {
			proxyHttpRequest(req, res, targetPort);
		});

		const response = await fetch(`http://127.0.0.1:${proxyPort}/api/trpc/projects.list`);
		const body = (await response.json()) as { ok: boolean };

		expect(response.status).toBe(200);
		expect(response.headers.get("x-upstream")).toBe("yes");
		expect(body.ok).toBe(true);
		expect(seenUrl).toBe("/api/trpc/projects.list");
		expect(seenHost).toBe(`127.0.0.1:${targetPort}`);
	});

	it("returns 502 when the upstream is unreachable", async () => {
		// Port 1 is reserved and never listening on loopback.
		const proxyPort = await startServer((req, res) => {
			proxyHttpRequest(req, res, 1);
		});
		const response = await fetch(`http://127.0.0.1:${proxyPort}/api/trpc/x`);
		expect(response.status).toBe(502);
	});
});
