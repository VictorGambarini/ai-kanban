import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
	getExtraAllowedHosts,
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	isKanbanRemoteHost,
	isKanbanRuntimeHttps,
} from "../core/runtime-endpoint";

export type CorsDecision =
	| { kind: "allow"; origin: string | null }
	| { kind: "preflight"; origin: string }
	| { kind: "reject"; origin: string };

export interface CorsGateInput {
	method: string | undefined;
	originHeader: string | undefined;
	allowedOrigins: ReadonlySet<string>;
}

const isDev = process.env.NODE_ENV === "development";

export function evaluateCors(input: CorsGateInput): CorsDecision {
	const origin = input.originHeader || null;
	const isPreflight = input.method === "OPTIONS";

	if (origin === null) {
		return { kind: "allow", origin: null };
	}

	if (!input.allowedOrigins.has(origin)) {
		return { kind: "reject", origin };
	}

	if (isPreflight) {
		return { kind: "preflight", origin };
	}

	return { kind: "allow", origin };
}

export interface HostGateInput {
	hostHeader: string | undefined;
	allowedHosts: ReadonlySet<string>;
}

export type HostDecision = { kind: "allow" } | { kind: "reject"; host: string | null };

export function evaluateHost(input: HostGateInput): HostDecision {
	if (!input.hostHeader) {
		return { kind: "reject", host: null };
	}

	if (!input.allowedHosts.has(input.hostHeader.toLowerCase())) {
		return { kind: "reject", host: input.hostHeader };
	}

	return { kind: "allow" };
}

/** True when `port` is the default for `scheme` (browsers omit it from headers). */
function isSchemeDefaultPort(port: number, scheme: "http" | "https"): boolean {
	return (scheme === "http" && port === 80) || (scheme === "https" && port === 443);
}

export function getAllowedHostHeaders(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const scheme = isKanbanRuntimeHttps() ? "https" : "http";
	const omitsPort = isSchemeDefaultPort(port, scheme);
	const allowed = new Set<string>();
	// Browsers omit the port from the Host header on the scheme default port
	// (80/http, 443/https), so accept both the bare host and the host:port form.
	const addHost = (host: string) => {
		allowed.add(`${host}:${port}`);
		if (omitsPort) {
			allowed.add(host);
		}
	};

	if (isKanbanRemoteHost()) {
		addHost(getKanbanRuntimeHost().toLowerCase());
		for (const extra of getExtraAllowedHosts()) {
			const value = extra.toLowerCase();
			// An operator-supplied value with an explicit port is used verbatim;
			// a bare hostname gets both the bare and host:port forms.
			if (value.includes(":")) {
				allowed.add(value);
			} else {
				addHost(value);
			}
		}
		return allowed;
	}

	addHost("localhost");
	addHost("127.0.0.1");
	if (isDev) {
		// Vite's default dev server host:port
		allowed.add("localhost:4173");
		allowed.add("127.0.0.1:4173");
	}
	return allowed;
}

/**
 * The set of browser Origin header values the server accepts. Mirrors the Host
 * allowlist but as full `scheme://host[:port]` origins, including the
 * port-omitted form on default ports (matching what browsers actually send).
 */
export function getAllowedOrigins(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const scheme = isKanbanRuntimeHttps() ? "https" : "http";
	const omitsPort = isSchemeDefaultPort(port, scheme);
	const origins = new Set<string>();
	const addOrigin = (host: string) => {
		origins.add(`${scheme}://${host}:${port}`);
		if (omitsPort) {
			origins.add(`${scheme}://${host}`);
		}
	};

	if (isKanbanRemoteHost()) {
		addOrigin(getKanbanRuntimeHost().toLowerCase());
		for (const extra of getExtraAllowedHosts()) {
			addOrigin(extra.toLowerCase());
		}
		return origins;
	}

	addOrigin("localhost");
	addOrigin("127.0.0.1");
	if (isDev) {
		// Vite's default dev server origin
		origins.add("http://localhost:4173");
		origins.add("http://127.0.0.1:4173");
	}
	return origins;
}

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].join(", ");
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Kanban-Workspace-Id"].join(", ");
const PREFLIGHT_MAX_AGE_SECONDS = "600";

function applyAllowedOriginHeaders(res: ServerResponse, origin: string): void {
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Vary", "Origin");
	res.setHeader("Access-Control-Allow-Credentials", "true");
}

function rejectRequest(res: ServerResponse, message: string): { end: boolean } {
	res.writeHead(403, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify({ error: message }));
	return { end: true };
}

function rejectSocket(socket: Duplex): { end: boolean } {
	socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
	socket.destroy();
	return { end: true };
}

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: req.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectRequest(res, "Host not allowed.");
	}

	const corsDecision = evaluateCors({
		method: req.method,
		originHeader: req.headers.origin,
		allowedOrigins: getAllowedOrigins(),
	});

	switch (corsDecision.kind) {
		case "allow": {
			if (corsDecision.origin !== null) {
				applyAllowedOriginHeaders(res, corsDecision.origin);
			}
			return { end: false };
		}
		case "preflight": {
			applyAllowedOriginHeaders(res, corsDecision.origin);
			res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
			res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
			res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
			res.writeHead(204);
			res.end();
			return { end: true };
		}
		case "reject": {
			return rejectRequest(res, "Origin not allowed.");
		}
	}
}

export function handleSocketUpgrade(request: IncomingMessage, socket: Duplex): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: request.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	const corsDecision = evaluateCors({
		method: request.method,
		originHeader: request.headers.origin,
		allowedOrigins: getAllowedOrigins(),
	});
	if (corsDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	return { end: false };
}
