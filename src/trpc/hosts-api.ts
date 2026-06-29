import type {
	RegisterRemoteHostInput,
	RemoteHostConnectionStatus,
	RemoteHostSummary,
	UpdateRemoteHostInput,
} from "../hosts/host-types";
import type { HostsManager } from "../hosts/hosts-manager";

export interface HostsApi {
	list: () => Promise<{ hosts: RemoteHostSummary[] }>;
	add: (input: RegisterRemoteHostInput) => Promise<RemoteHostSummary>;
	update: (input: { hostId: string; patch: UpdateRemoteHostInput }) => Promise<RemoteHostSummary | null>;
	remove: (input: { hostId: string }) => Promise<{ ok: boolean }>;
	connect: (input: { hostId: string }) => Promise<RemoteHostConnectionStatus | null>;
	restart: (input: { hostId: string }) => Promise<RemoteHostConnectionStatus | null>;
	disconnect: (input: { hostId: string }) => Promise<{ ok: boolean }>;
}

export interface CreateHostsApiDependencies {
	hostsManager: HostsManager;
}

export function createHostsApi(deps: CreateHostsApiDependencies): HostsApi {
	const { hostsManager } = deps;
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
