import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

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

function rewriteHostHeader(headers: IncomingMessage["headers"], targetPort: number): IncomingMessage["headers"] {
	// The remote runtime is loopback-bound (no Host/Origin gating), so pointing
	// Host at the forwarded port keeps it happy and avoids DNS-rebind rejection.
	return { ...headers, host: `${LOOPBACK}:${targetPort}` };
}

/**
 * Reverse-proxy an HTTP request to a host's forwarded loopback port. The request
 * body is streamed, so this must run before anything else consumes `req`.
 */
export function proxyHttpRequest(req: IncomingMessage, res: ServerResponse, targetPort: number): void {
	const proxyReq = httpRequest(
		{
			host: LOOPBACK,
			port: targetPort,
			method: req.method,
			path: req.url,
			headers: rewriteHostHeader(req.headers, targetPort),
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

function serializeRequestHead(req: IncomingMessage, targetPort: number): string {
	const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
	for (const [key, value] of Object.entries(rewriteHostHeader(req.headers, targetPort))) {
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
	clientSocket: Socket,
	head: Buffer,
	targetPort: number,
): void {
	const upstream = netConnect(targetPort, LOOPBACK, () => {
		upstream.write(serializeRequestHead(req, targetPort));
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
