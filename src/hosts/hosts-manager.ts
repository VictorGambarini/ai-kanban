import packageJson from "../../package.json" with { type: "json" };
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
	fetchRemoteRuntimeVersion,
	type RemoteRuntimeBootstrapResult,
	stopRemoteRuntime,
} from "./remote-runtime-bootstrap";
import { type RemoteHostConnection, RemoteHostConnectionManager } from "./ssh-connection-manager";

/** Default npm package spec used to launch the remote runtime via npx, pinned to this hub's version. */
function defaultNpxPackageSpec(): string | null {
	const name = typeof packageJson.name === "string" ? packageJson.name : null;
	const version = typeof packageJson.version === "string" ? packageJson.version : null;
	return name && version ? `${name}@${version}` : null;
}

export interface HostsManagerOptions {
	connectionManager?: RemoteHostConnectionManager;
	/** Whether to launch the remote runtime when a connection comes up. Defaults to true. */
	autoBootstrap?: boolean;
	/**
	 * npm package spec launched on the remote via `npx`, pinning the remote runtime
	 * to the hub's version. Defaults to `<this package>@<this version>`. Pass `null`
	 * to fall back to a directly-installed `ai-kanban` binary on the remote.
	 */
	npxPackageSpec?: string | null;
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
	private readonly npxPackageSpec: string | null;
	private readonly warn: (message: string) => void;
	private readonly bootstrappedHostIds = new Set<string>();
	/** Last remote-runtime bootstrap failure per host, surfaced to the UI. */
	private readonly runtimeErrors = new Map<string, string>();
	/** Remote runtime version per host (from its /api/version), for drift detection. */
	private readonly runtimeVersions = new Map<string, string>();
	/** Runtime port per connected host, needed to rewrite the proxied Host header. */
	private readonly runtimePorts = new Map<string, number>();

	constructor(options: HostsManagerOptions = {}) {
		this.connectionManager = options.connectionManager ?? new RemoteHostConnectionManager();
		this.autoBootstrap = options.autoBootstrap ?? true;
		this.npxPackageSpec = options.npxPackageSpec === undefined ? defaultNpxPackageSpec() : options.npxPackageSpec;
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
		return hosts.map((host) => ({
			host,
			status: this.connectionManager.getStatus(host.id),
			runtimeError: this.runtimeErrors.get(host.id) ?? null,
			runtimeVersion: this.runtimeVersions.get(host.id) ?? null,
		}));
	}

	/** The last remote-runtime bootstrap failure for a host, or null. */
	getRuntimeError(hostId: string): string | null {
		return this.runtimeErrors.get(hostId) ?? null;
	}

	/** The remote runtime version for a host (from its /api/version), or null. */
	getRuntimeVersion(hostId: string): string | null {
		return this.runtimeVersions.get(hostId) ?? null;
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
		this.runtimeErrors.delete(hostId);
		this.runtimeVersions.delete(hostId);
		this.runtimePorts.delete(hostId);
		return await removeRemoteHost(hostId);
	}

	async connectHost(hostId: string): Promise<RemoteHostConnectionStatus | null> {
		const host = await getRemoteHost(hostId);
		if (!host) {
			return null;
		}
		// Force a clean reconnect so an explicit retry also re-runs bootstrap (a
		// runtime that failed to start won't re-trigger on an already-open tunnel).
		this.connectionManager.disconnectHost(hostId);
		this.bootstrappedHostIds.delete(hostId);
		const connection = this.beginConnection(host);
		return connection.getStatus();
	}

	/**
	 * Restart the remote runtime: stop the running process, then re-bootstrap a
	 * fresh one. The new runtime re-runs agent discovery, so this is how a newly
	 * installed agent (e.g. `claude`) on the VM gets picked up without manual SSH.
	 */
	async restartHost(hostId: string): Promise<RemoteHostConnectionStatus | null> {
		const host = await getRemoteHost(hostId);
		if (!host) {
			return null;
		}
		// Stop the current runtime while the tunnel is still up; if it isn't
		// connected there's nothing to stop and the reconnect below relaunches it.
		const connection = this.connectionManager.getConnection(hostId);
		if (connection && connection.getStatus().state === "connected") {
			try {
				await stopRemoteRuntime((command) => connection.exec(command), host.runtimePort);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.warn(`Failed to stop remote runtime on "${hostId}": ${message}`);
			}
		}
		// Clean reconnect re-runs bootstrap against the now-stopped runtime, which
		// health-checks as down and so relaunches a fresh process.
		return this.connectHost(hostId);
	}

	disconnectHost(hostId: string): void {
		this.connectionManager.disconnectHost(hostId);
		this.bootstrappedHostIds.delete(hostId);
		this.runtimeErrors.delete(hostId);
		this.runtimeVersions.delete(hostId);
		this.runtimePorts.delete(hostId);
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

	/**
	 * The remote runtime's own port (what it's bound to on the VM). The proxy needs
	 * this to set a Host header the remote's allowlist accepts — its forwarded
	 * loopback port on the hub differs from the port the remote is actually bound to.
	 */
	getRuntimePort(hostId: string): number | null {
		return this.runtimePorts.get(hostId) ?? null;
	}

	onStatusChange(listener: (status: RemoteHostConnectionStatus) => void): () => void {
		return this.connectionManager.onStatusChange(listener);
	}

	disconnectAll(): void {
		this.connectionManager.disconnectAll();
		this.bootstrappedHostIds.clear();
	}

	private beginConnection(host: RemoteHost): RemoteHostConnection {
		// A fresh connection attempt invalidates any prior bootstrap failure / version.
		this.runtimeErrors.delete(host.id);
		this.runtimeVersions.delete(host.id);
		this.runtimePorts.set(host.id, host.runtimePort);
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
			const result = await ensureRemoteRuntime((command) => connection.exec(command), healthCheck, {
				runtimePort: host.runtimePort,
				npxPackageSpec: this.npxPackageSpec ?? undefined,
			});
			this.runtimeErrors.delete(host.id);
			// Record the version the remote actually reports, for drift detection.
			const localPort = connection.getStatus().localPort;
			if (localPort !== null) {
				const version = await fetchRemoteRuntimeVersion(localPort);
				if (version) {
					this.runtimeVersions.set(host.id, version);
				}
			}
			return result;
		} catch (error) {
			// Allow a future reconnect to retry bootstrap, and surface the reason to
			// the UI (the SSH tunnel is up, so the connection status alone looks fine).
			this.bootstrappedHostIds.delete(host.id);
			const message = error instanceof Error ? error.message : String(error);
			this.runtimeErrors.set(host.id, message);
			this.warn(`Failed to bootstrap remote runtime on "${host.id}": ${message}`);
			return null;
		}
	}
}
