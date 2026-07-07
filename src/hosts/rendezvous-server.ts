import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Connection } from "ssh2";
import { Server as Ssh2Server, utils as ssh2Utils } from "ssh2";

import { getRuntimeHomePath } from "../state/workspace-state";
import { getRemoteHost } from "./host-registry";
import { hashReverseHostToken } from "./host-types";
import type { HostsManager } from "./hosts-manager";

const HOST_KEY_FILENAME = "rendezvous-host-key";

/** Per-connector state while a reverse host is attached. */
interface AttachedConnector {
	hostId: string;
	runtimePort: number;
	forwardedPort: number | null;
	listener: NetServer | null;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Parse a reverse connector's `hostId:runtimePort` username. */
function parseConnectorUsername(username: string): { hostId: string; runtimePort: number } | null {
	const separator = username.lastIndexOf(":");
	if (separator <= 0) {
		return null;
	}
	const hostId = username.slice(0, separator);
	const runtimePort = Number.parseInt(username.slice(separator + 1), 10);
	if (!hostId || !Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) {
		return null;
	}
	return { hostId, runtimePort };
}

function computeFingerprint(privatePem: string): string {
	const parsed = ssh2Utils.parseKey(privatePem);
	if (parsed instanceof Error) {
		throw parsed;
	}
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	const digest = createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "");
	return `SHA256:${digest}`;
}

/** Load the persisted rendezvous host key, generating (and chmod 600) one on first run. */
async function loadOrCreateHostKey(): Promise<{ privatePem: string; fingerprint: string }> {
	const path = join(getRuntimeHomePath(), HOST_KEY_FILENAME);
	try {
		const pem = await readFile(path, "utf8");
		return { privatePem: pem, fingerprint: computeFingerprint(pem) };
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			throw error;
		}
		const generated = ssh2Utils.generateKeyPairSync("ed25519");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, generated.private, { mode: 0o600 });
		return { privatePem: generated.private, fingerprint: computeFingerprint(generated.private) };
	}
}

async function tokenMatches(hostId: string, token: string): Promise<boolean> {
	const host = await getRemoteHost(hostId);
	if (!host || host.transport !== "reverse" || !host.reverse) {
		return false;
	}
	const provided = Buffer.from(hashReverseHostToken(token));
	const expected = Buffer.from(host.reverse.tokenHash);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export interface RendezvousServerOptions {
	hostsManager: HostsManager;
	port: number;
	/** Interface to bind. Defaults to loopback; expose over Tailscale/WireGuard, never 0.0.0.0. */
	bindAddress?: string;
	warn?: (message: string) => void;
}

/**
 * In-process SSH rendezvous server for **reverse (dial-in) hosts**. A laptop behind
 * NAT runs `ai-kanban connect`, which authenticates here with its pairing token and
 * reverse-forwards (`forwardIn`) its local runtime to a hub loopback port. The hub
 * proxy then reaches that host exactly like a forward host — only the tunnel's origin
 * differs. Bind to a private interface; the token is the auth boundary.
 */
export class RendezvousServer {
	private readonly hostsManager: HostsManager;
	private readonly port: number;
	private readonly bindAddress: string;
	private readonly warn: (message: string) => void;
	private server: Ssh2Server | null = null;
	private fingerprint: string | null = null;
	private boundPort: number | null = null;
	/** The connector currently authoritative for each hostId (guards stale-close races). */
	private readonly current = new Map<string, AttachedConnector>();

	constructor(options: RendezvousServerOptions) {
		this.hostsManager = options.hostsManager;
		this.port = options.port;
		this.bindAddress = options.bindAddress ?? "127.0.0.1";
		this.warn = options.warn ?? (() => {});
	}

	/** The rendezvous host-key fingerprint connectors should pin. Null before start(). */
	getHostKeyFingerprint(): string | null {
		return this.fingerprint;
	}

	/** The port the server actually bound (useful when constructed with port 0). Null before start(). */
	getPort(): number | null {
		return this.boundPort;
	}

	async start(): Promise<void> {
		const { privatePem, fingerprint } = await loadOrCreateHostKey();
		this.fingerprint = fingerprint;
		this.server = new Ssh2Server({ hostKeys: [privatePem] }, (client) => this.handleClient(client));
		await new Promise<void>((resolve, reject) => {
			const server = this.server;
			if (!server) {
				reject(new Error("Rendezvous server was closed before it could start."));
				return;
			}
			server.on("error", (error: Error) => this.warn(`Rendezvous server error: ${error.message}`));
			server.listen(this.port, this.bindAddress, () => {
				const address = server.address();
				this.boundPort = typeof address === "object" && address ? address.port : this.port;
				resolve();
			});
		});
	}

	private handleClient(client: Connection): void {
		let attached: AttachedConnector | null = null;

		client.on("authentication", (ctx) => {
			if (ctx.method !== "password") {
				ctx.reject(["password"]);
				return;
			}
			const parsed = parseConnectorUsername(ctx.username);
			if (!parsed) {
				ctx.reject();
				return;
			}
			void tokenMatches(parsed.hostId, ctx.password)
				.then((ok) => {
					if (!ok) {
						ctx.reject();
						return;
					}
					attached = {
						hostId: parsed.hostId,
						runtimePort: parsed.runtimePort,
						forwardedPort: null,
						listener: null,
					};
					ctx.accept();
				})
				.catch(() => ctx.reject());
		});

		client.on("request", (accept, reject, name, info) => {
			if (name !== "tcpip-forward" || !attached) {
				reject?.();
				return;
			}
			this.startForward(client, attached, info.bindAddr || "127.0.0.1", accept);
		});

		const teardown = () => {
			if (!attached) {
				return;
			}
			attached.listener?.close();
			// Only clear shared state if this connector is still the authoritative one.
			if (this.current.get(attached.hostId) === attached) {
				this.current.delete(attached.hostId);
				this.hostsManager.setReverseHostDisconnected(attached.hostId);
			}
			attached = null;
		};
		client.on("close", teardown);
		client.on("end", teardown);
		client.on("error", (error) => this.warn(`Rendezvous connector error: ${error.message}`));
	}

	private startForward(
		client: Connection,
		connector: AttachedConnector,
		bindAddr: string,
		accept: ((chosenPort?: number) => void) | undefined,
	): void {
		const listener = createNetServer((socket: Socket) => {
			client.forwardOut(
				bindAddr,
				connector.forwardedPort ?? 0,
				socket.remoteAddress ?? "127.0.0.1",
				socket.remotePort ?? 0,
				(error, channel) => {
					if (error || !channel) {
						socket.destroy();
						return;
					}
					socket.pipe(channel).pipe(socket);
				},
			);
		});
		listener.on("error", (error) => this.warn(`Rendezvous forward listener error: ${error.message}`));
		// Bind loopback: only the hub proxy reaches this forwarded port.
		listener.listen(0, "127.0.0.1", () => {
			const address = listener.address();
			const forwardedPort = typeof address === "object" && address ? address.port : 0;
			connector.forwardedPort = forwardedPort;
			connector.listener = listener;
			accept?.(forwardedPort);
			// Now that both the runtime port (from auth) and the forwarded port are known,
			// the reverse host is reachable: publish it and take authority for the hostId.
			this.current.set(connector.hostId, connector);
			this.hostsManager.setReverseHostConnected(connector.hostId, {
				forwardedPort,
				runtimePort: connector.runtimePort,
			});
		});
	}

	close(): void {
		for (const connector of this.current.values()) {
			connector.listener?.close();
			this.hostsManager.setReverseHostDisconnected(connector.hostId);
		}
		this.current.clear();
		this.server?.close();
		this.server = null;
	}
}
