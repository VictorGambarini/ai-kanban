import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import { type Client, type ClientChannel, type ConnectConfig, Client as Ssh2Client } from "ssh2";

import type { RemoteHost, RemoteHostConnectionState, RemoteHostConnectionStatus } from "./host-types";

const LOOPBACK = "127.0.0.1";
const KEEPALIVE_INTERVAL_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

/** Factory for the ssh2 client, injectable so tests can supply a fake. */
export type SshClientFactory = () => Client;

const defaultSshClientFactory: SshClientFactory = () => new Ssh2Client();

export interface RemoteHostConnectionOptions {
	sshClientFactory?: SshClientFactory;
	reconnectBaseDelayMs?: number;
	reconnectMaxDelayMs?: number;
	now?: () => number;
}

function buildConnectConfig(host: RemoteHost): ConnectConfig {
	const { ssh } = host;
	const config: ConnectConfig = {
		host: ssh.hostname,
		port: ssh.port,
		username: ssh.username,
		keepaliveInterval: KEEPALIVE_INTERVAL_MS,
	};
	if (ssh.privateKeyPath) {
		config.privateKey = readFileSync(ssh.privateKeyPath);
	}
	if (ssh.passphraseEnv) {
		const passphrase = process.env[ssh.passphraseEnv];
		if (passphrase) {
			config.passphrase = passphrase;
		}
	}
	if (ssh.useAgent) {
		const agent = process.env.SSH_AUTH_SOCK;
		if (agent) {
			config.agent = agent;
		}
	}
	return config;
}

/**
 * Maintains a single SSH connection to a {@link RemoteHost} and forwards a local
 * loopback port to the host's remote runtime port — the programmatic equivalent
 * of `ssh -L <localPort>:127.0.0.1:<runtimePort>`. Reconnects with exponential
 * backoff and surfaces lifecycle changes through {@link onStatusChange}.
 */
export class RemoteHostConnection {
	private readonly sshClientFactory: SshClientFactory;
	private readonly reconnectBaseDelayMs: number;
	private readonly reconnectMaxDelayMs: number;
	private readonly now: () => number;

	private readonly statusListeners = new Set<(status: RemoteHostConnectionStatus) => void>();
	private client: Client | null = null;
	private forwardServer: Server | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempts = 0;
	private stopped = true;
	private state: RemoteHostConnectionState = "disconnected";
	private localPort: number | null = null;
	private error: string | null = null;
	private updatedAt: number;

	constructor(
		private readonly host: RemoteHost,
		options: RemoteHostConnectionOptions = {},
	) {
		this.sshClientFactory = options.sshClientFactory ?? defaultSshClientFactory;
		this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
		this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
		this.now = options.now ?? Date.now;
		this.updatedAt = this.now();
	}

	get hostId(): string {
		return this.host.id;
	}

	getStatus(): RemoteHostConnectionStatus {
		return {
			hostId: this.host.id,
			state: this.state,
			localPort: this.localPort,
			error: this.error,
			updatedAt: this.updatedAt,
		};
	}

	onStatusChange(listener: (status: RemoteHostConnectionStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	/** Begin connecting (idempotent). Safe to call after a previous {@link disconnect}. */
	connect(): void {
		if (!this.stopped) {
			return;
		}
		this.stopped = false;
		this.reconnectAttempts = 0;
		this.openConnection();
	}

	/** Tear down the connection and stop reconnecting. */
	disconnect(): void {
		this.stopped = true;
		this.clearReconnectTimer();
		this.teardownTransport();
		this.setState("disconnected", { localPort: null, error: null });
	}

	private openConnection(): void {
		if (this.stopped) {
			return;
		}
		this.setState("connecting", { localPort: null, error: null });
		const client = this.sshClientFactory();
		this.client = client;
		client.on("ready", () => {
			this.handleReady(client);
		});
		client.on("error", (err: Error) => {
			this.handleFailure(err.message);
		});
		client.on("close", () => {
			// A close without a prior "ready" is handled by the error path; a close
			// after being connected means the tunnel dropped and should reconnect.
			if (!this.stopped && this.state === "connected") {
				this.handleFailure("SSH connection closed.");
			}
		});
		try {
			client.connect(buildConnectConfig(this.host));
		} catch (err) {
			this.handleFailure(err instanceof Error ? err.message : String(err));
		}
	}

	private handleReady(client: Client): void {
		if (this.stopped || this.client !== client) {
			return;
		}
		const server = createServer((socket: Socket) => {
			this.handleForwardConnection(client, socket);
		});
		server.on("error", (err: Error) => {
			this.handleFailure(`Local forward failed: ${err.message}`);
		});
		server.listen(0, LOOPBACK, () => {
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : null;
			if (port === null) {
				this.handleFailure("Could not determine forwarded local port.");
				return;
			}
			this.forwardServer = server;
			this.reconnectAttempts = 0;
			this.setState("connected", { localPort: port, error: null });
		});
	}

	private handleForwardConnection(client: Client, socket: Socket): void {
		const { port: srcPort, address: srcAddress } = socket.address() as { port?: number; address?: string };
		client.forwardOut(
			srcAddress ?? LOOPBACK,
			srcPort ?? 0,
			LOOPBACK,
			this.host.runtimePort,
			(err: Error | undefined, channel: ClientChannel) => {
				if (err) {
					socket.destroy();
					return;
				}
				socket.pipe(channel);
				channel.pipe(socket);
				const closeBoth = () => {
					socket.destroy();
					channel.destroy();
				};
				socket.on("error", closeBoth);
				channel.on("error", closeBoth);
			},
		);
	}

	private handleFailure(message: string): void {
		this.teardownTransport();
		if (this.stopped) {
			return;
		}
		this.setState("error", { localPort: null, error: message });
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) {
			return;
		}
		const delay = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * 2 ** this.reconnectAttempts);
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.openConnection();
		}, delay);
		// Don't keep the process alive solely for a reconnect attempt.
		this.reconnectTimer.unref?.();
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private teardownTransport(): void {
		if (this.forwardServer) {
			this.forwardServer.close();
			this.forwardServer = null;
		}
		if (this.client) {
			this.client.removeAllListeners();
			try {
				this.client.end();
			} catch {
				// Best effort: client may already be closed.
			}
			this.client = null;
		}
	}

	private setState(state: RemoteHostConnectionState, patch: { localPort: number | null; error: string | null }): void {
		this.state = state;
		this.localPort = patch.localPort;
		this.error = patch.error;
		this.updatedAt = this.now();
		const status = this.getStatus();
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}
}

/**
 * Owns the set of {@link RemoteHostConnection}s, one per registered host, and
 * exposes a flat view of their statuses for the hub proxy and UI.
 */
export class RemoteHostConnectionManager {
	private readonly connections = new Map<string, RemoteHostConnection>();
	private readonly statusListeners = new Set<(status: RemoteHostConnectionStatus) => void>();

	constructor(private readonly connectionOptions: RemoteHostConnectionOptions = {}) {}

	/** Start (or restart) a connection for the given host. */
	connectHost(host: RemoteHost): RemoteHostConnection {
		const existing = this.connections.get(host.id);
		if (existing) {
			existing.connect();
			return existing;
		}
		const connection = new RemoteHostConnection(host, this.connectionOptions);
		connection.onStatusChange((status) => {
			for (const listener of this.statusListeners) {
				listener(status);
			}
		});
		this.connections.set(host.id, connection);
		connection.connect();
		return connection;
	}

	disconnectHost(hostId: string): void {
		const connection = this.connections.get(hostId);
		if (!connection) {
			return;
		}
		connection.disconnect();
		this.connections.delete(hostId);
	}

	getConnection(hostId: string): RemoteHostConnection | null {
		return this.connections.get(hostId) ?? null;
	}

	getStatus(hostId: string): RemoteHostConnectionStatus | null {
		return this.connections.get(hostId)?.getStatus() ?? null;
	}

	listStatuses(): RemoteHostConnectionStatus[] {
		return Array.from(this.connections.values()).map((connection) => connection.getStatus());
	}

	onStatusChange(listener: (status: RemoteHostConnectionStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	disconnectAll(): void {
		for (const connection of this.connections.values()) {
			connection.disconnect();
		}
		this.connections.clear();
	}
}
