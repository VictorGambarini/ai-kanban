import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";

const LOOPBACK = "127.0.0.1";

/** Sentinel host id meaning "the hub's own local runtime" — i.e. do not proxy. */
export const LOCAL_HOST_ID = "local";

const HOST_ID_HEADER = "x-kanban-host-id";

/**
 * Read the target host id from a request. Returns {@link LOCAL_HOST_ID} when no
 * host is specified, so callers can treat "unspecified" as "serve locally".
 */
export function readHostIdFromRequest(request: IncomingMessage, requestUrl: URL): string {
	const headerValue = request.headers[HOST_ID_HEADER];
	const headerHostId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerHostId === "string" && headerHostId.trim()) {
		return headerHostId.trim();
	}
	const queryHostId = requestUrl.searchParams.get("hostId");
	if (typeof queryHostId === "string" && queryHostId.trim()) {
		return queryHostId.trim();
	}
	return LOCAL_HOST_ID;
}

export function isLocalHostId(hostId: string): boolean {
	return hostId === LOCAL_HOST_ID;
}

function rewriteProxyHeaders(headers: IncomingMessage["headers"], runtimePort: number): IncomingMessage["headers"] {
	// The remote runtime guards both Host and Origin against DNS-rebinding/CSRF and
	// only accepts its OWN bound `127.0.0.1:<runtimePort>`. We reach it through the
	// hub's forwarded loopback port (a different number) and the browser's Origin is
	// the hub's, so BOTH must be rewritten to the remote's runtime port — otherwise
	// the remote rejects with 403 ("Host not allowed" / "Origin not allowed"). This
	// bites whenever the hub port differs from the remote runtime port; when they
	// happen to match it works by coincidence. The tunnel is loopback http.
	const rewritten: IncomingMessage["headers"] = { ...headers, host: `${LOOPBACK}:${runtimePort}` };
	// Only rewrite Origin when the client actually sent one (e.g. WebSocket
	// upgrades and cross-origin fetches); never fabricate one otherwise.
	if (headers.origin !== undefined) {
		rewritten.origin = `http://${LOOPBACK}:${runtimePort}`;
	}
	return rewritten;
}

/**
 * Reverse-proxy an HTTP request to a host's forwarded loopback port. The request
 * body is streamed, so this must run before anything else consumes `req`.
 *
 * `forwardedPort` is the hub's local tunnel port we connect to; `runtimePort` is
 * the remote's own bound port, used only for the Host header.
 */
export function proxyHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	forwardedPort: number,
	runtimePort: number,
): void {
	const proxyReq = httpRequest(
		{
			host: LOOPBACK,
			port: forwardedPort,
			method: req.method,
			path: req.url,
			headers: rewriteProxyHeaders(req.headers, runtimePort),
		},
		(proxyRes) => {
			res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
			proxyRes.pipe(res);
		},
	);
	proxyReq.on("error", () => {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
		}
		res.end('{"error":"Bad gateway: remote host unreachable."}');
	});
	req.pipe(proxyReq);
}

function serializeRequestHead(req: IncomingMessage, runtimePort: number): string {
	const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
	for (const [key, value] of Object.entries(rewriteProxyHeaders(req.headers, runtimePort))) {
		if (value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				lines.push(`${key}: ${entry}`);
			}
		} else {
			lines.push(`${key}: ${value}`);
		}
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Reverse-proxy a WebSocket upgrade to a host's forwarded loopback port by
 * replaying the handshake over a raw TCP connection and piping both directions.
 */
export function proxyWebSocketUpgrade(
	req: IncomingMessage,
	clientSocket: Duplex,
	head: Buffer,
	forwardedPort: number,
	runtimePort: number,
): void {
	const upstream = netConnect(forwardedPort, LOOPBACK, () => {
		upstream.write(serializeRequestHead(req, runtimePort));
		if (head.length > 0) {
			upstream.write(head);
		}
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	upstream.on("error", () => {
		clientSocket.destroy();
	});
	clientSocket.on("error", () => {
		upstream.destroy();
	});
}
