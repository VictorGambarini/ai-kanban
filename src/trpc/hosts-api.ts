import { registerReverseHost } from "../hosts/host-registry";
import type {
	RegisterRemoteHostInput,
	RegisterReverseHostInput,
	RemoteHost,
	RemoteHostConnectionStatus,
	RemoteHostSummary,
	UpdateRemoteHostInput,
} from "../hosts/host-types";
import type { HostsManager } from "../hosts/hosts-manager";

/** Everything the connector needs to dial in for a freshly-created reverse host. */
export interface AddReverseHostResult {
	host: RemoteHost;
	/** One-time pairing token (never shown again). */
	token: string;
	/** Port the hub's rendezvous server listens on. */
	rendezvousPort: number;
	/** Rendezvous host-key fingerprint the connector should pin. */
	hostKeyFingerprint: string | null;
}

export interface HostsApi {
	list: () => Promise<{ hosts: RemoteHostSummary[] }>;
	add: (input: RegisterRemoteHostInput) => Promise<RemoteHostSummary>;
	addReverse: (input: RegisterReverseHostInput) => Promise<AddReverseHostResult>;
	update: (input: { hostId: string; patch: UpdateRemoteHostInput }) => Promise<RemoteHostSummary | null>;
	remove: (input: { hostId: string }) => Promise<{ ok: boolean }>;
	connect: (input: { hostId: string }) => Promise<RemoteHostConnectionStatus | null>;
	restart: (input: { hostId: string }) => Promise<RemoteHostConnectionStatus | null>;
	disconnect: (input: { hostId: string }) => Promise<{ ok: boolean }>;
}

export interface CreateHostsApiDependencies {
	hostsManager: HostsManager;
	/** Rendezvous server info when dial-in is enabled, else null. */
	getRendezvousInfo?: () => { port: number; fingerprint: string | null } | null;
}

export function createHostsApi(deps: CreateHostsApiDependencies): HostsApi {
	const { hostsManager } = deps;
	const getRendezvousInfo = deps.getRendezvousInfo ?? (() => null);
	return {
		list: async () => ({ hosts: await hostsManager.listSummaries() }),
		add: async (input) => {
			const host = await hostsManager.registerHost(input);
			return {
				host,
				status: hostsManager.getStatus(host.id),
				runtimeError: hostsManager.getRuntimeError(host.id),
				runtimeVersion: hostsManager.getRuntimeVersion(host.id),
			};
		},
		addReverse: async (input) => {
			const info = getRendezvousInfo();
			if (!info) {
				throw new Error(
					"Dial-in hosts are disabled. Start the hub with --rendezvous-port <port> (bound to a private interface) to accept them.",
				);
			}
			const { host, token } = await registerReverseHost(input);
			return { host, token, rendezvousPort: info.port, hostKeyFingerprint: info.fingerprint };
		},
		update: async ({ hostId, patch }) => {
			const host = await hostsManager.updateHost(hostId, patch);
			if (!host) {
				return null;
			}
			return {
				host,
				status: hostsManager.getStatus(host.id),
				runtimeError: hostsManager.getRuntimeError(host.id),
				runtimeVersion: hostsManager.getRuntimeVersion(host.id),
			};
		},
		remove: async ({ hostId }) => ({ ok: await hostsManager.removeHost(hostId) }),
		connect: async ({ hostId }) => await hostsManager.connectHost(hostId),
		restart: async ({ hostId }) => await hostsManager.restartHost(hostId),
		disconnect: async ({ hostId }) => {
			hostsManager.disconnectHost(hostId);
			return { ok: true };
		},
	};
}
