import {
	getRemoteHost,
	listRemoteHosts,
	registerRemoteHost,
	removeRemoteHost,
	updateRemoteHost,
} from "./host-registry";
import type {
	RegisterRemoteHostInput,
	RemoteHost,
	RemoteHostConnectionStatus,
	RemoteHostSummary,
	UpdateRemoteHostInput,
} from "./host-types";
import {
	createForwardedPortHealthCheck,
	ensureRemoteRuntime,
	type RemoteRuntimeBootstrapResult,
} from "./remote-runtime-bootstrap";
import { type RemoteHostConnection, RemoteHostConnectionManager } from "./ssh-connection-manager";

export interface HostsManagerOptions {
	connectionManager?: RemoteHostConnectionManager;
	/** Whether to launch the remote runtime when a connection comes up. Defaults to true. */
	autoBootstrap?: boolean;
	warn?: (message: string) => void;
}

/**
 * Owns the lifecycle of every registered remote host: persistence (via the
 * registry), SSH connections + port forwarding (via the connection manager),
 * and remote runtime bootstrap when a connection comes up. This is the single
 * integration point the server and the hosts tRPC API depend on.
 */
export class HostsManager {
	private readonly connectionManager: RemoteHostConnectionManager;
	private readonly autoBootstrap: boolean;
	private readonly warn: (message: string) => void;
	private readonly bootstrappedHostIds = new Set<string>();

	constructor(options: HostsManagerOptions = {}) {
		this.connectionManager = options.connectionManager ?? new RemoteHostConnectionManager();
		this.autoBootstrap = options.autoBootstrap ?? true;
		this.warn = options.warn ?? (() => {});
	}

	/** Connect every registered host. Safe to call once at server startup. */
	async start(): Promise<void> {
		const hosts = await listRemoteHosts();
		for (const host of hosts) {
			this.beginConnection(host);
		}
	}

	listHosts(): Promise<RemoteHost[]> {
		return listRemoteHosts();
	}

	/** Hosts paired with their live connection status, for the UI. */
	async listSummaries(): Promise<RemoteHostSummary[]> {
		const hosts = await listRemoteHosts();
		return hosts.map((host) => ({ host, status: this.connectionManager.getStatus(host.id) }));
	}

	getHost(hostId: string): Promise<RemoteHost | null> {
		return getRemoteHost(hostId);
	}

	async registerHost(input: RegisterRemoteHostInput): Promise<RemoteHost> {
		const host = await registerRemoteHost(input);
		this.beginConnection(host);
		return host;
	}

	async updateHost(hostId: string, patch: UpdateRemoteHostInput): Promise<RemoteHost | null> {
		const host = await updateRemoteHost(hostId, patch);
		if (host) {
			// Reconnect with the new settings.
			this.connectionManager.disconnectHost(hostId);
			this.bootstrappedHostIds.delete(hostId);
			this.beginConnection(host);
		}
		return host;
	}

	async removeHost(hostId: string): Promise<boolean> {
		this.connectionManager.disconnectHost(hostId);
		this.bootstrappedHostIds.delete(hostId);
		return await removeRemoteHost(hostId);
	}

	async connectHost(hostId: string): Promise<RemoteHostConnectionStatus | null> {
		const host = await getRemoteHost(hostId);
		if (!host) {
			return null;
		}
		const connection = this.beginConnection(host);
		return connection.getStatus();
	}

	disconnectHost(hostId: string): void {
		this.connectionManager.disconnectHost(hostId);
		this.bootstrappedHostIds.delete(hostId);
	}

	getStatus(hostId: string): RemoteHostConnectionStatus | null {
		return this.connectionManager.getStatus(hostId);
	}

	listStatuses(): RemoteHostConnectionStatus[] {
		return this.connectionManager.listStatuses();
	}

	/** The hub loopback port that tunnels to a host's runtime, or null if not connected. */
	getForwardedPort(hostId: string): number | null {
		const status = this.connectionManager.getStatus(hostId);
		return status?.state === "connected" ? status.localPort : null;
	}

	onStatusChange(listener: (status: RemoteHostConnectionStatus) => void): () => void {
		return this.connectionManager.onStatusChange(listener);
	}

	disconnectAll(): void {
		this.connectionManager.disconnectAll();
		this.bootstrappedHostIds.clear();
	}

	private beginConnection(host: RemoteHost): RemoteHostConnection {
		const connection = this.connectionManager.connectHost(host);
		if (this.autoBootstrap) {
			connection.onStatusChange((status) => {
				if (status.state === "connected" && !this.bootstrappedHostIds.has(host.id)) {
					this.bootstrappedHostIds.add(host.id);
					void this.bootstrapHost(host, connection);
				}
			});
		}
		return connection;
	}

	private async bootstrapHost(
		host: RemoteHost,
		connection: RemoteHostConnection,
	): Promise<RemoteRuntimeBootstrapResult | null> {
		try {
			const healthCheck = createForwardedPortHealthCheck(() => {
				const status = connection.getStatus();
				return status.state === "connected" ? status.localPort : null;
			});
			return await ensureRemoteRuntime((command) => connection.exec(command), healthCheck, {
				runtimePort: host.runtimePort,
			});
		} catch (error) {
			// Allow a future reconnect to retry bootstrap.
			this.bootstrappedHostIds.delete(host.id);
			this.warn(
				`Failed to bootstrap remote runtime on "${host.id}": ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}
}
