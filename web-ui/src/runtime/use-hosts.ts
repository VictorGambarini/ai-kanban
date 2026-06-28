import type { RuntimeAppRouterOutputs } from "@runtime-trpc";
import { useCallback, useEffect, useState } from "react";

import { getHubTrpcClient } from "@/runtime/trpc-client";

export type RemoteHostSummary = RuntimeAppRouterOutputs["hosts"]["list"]["hosts"][number];

export interface RegisterHostInput {
	label: string;
	ssh: {
		hostname: string;
		port?: number;
		username: string;
		privateKeyPath?: string;
		useAgent?: boolean;
		passphraseEnv?: string;
	};
	runtimePort?: number;
}

export interface UpdateHostInput {
	label?: string;
	ssh?: {
		hostname?: string;
		port?: number;
		username?: string;
		privateKeyPath?: string;
		useAgent?: boolean;
		passphraseEnv?: string;
	};
	runtimePort?: number;
}

const REFRESH_INTERVAL_MS = 5_000;

export interface UseHostsResult {
	hosts: RemoteHostSummary[];
	isLoading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	addHost: (input: RegisterHostInput) => Promise<RemoteHostSummary>;
	updateHost: (hostId: string, patch: UpdateHostInput) => Promise<RemoteHostSummary | null>;
	removeHost: (hostId: string) => Promise<void>;
	connectHost: (hostId: string) => Promise<void>;
	disconnectHost: (hostId: string) => Promise<void>;
}

/**
 * Fetches and polls the hub's registered remote hosts (always via the hub
 * client, so it works even while a remote host is the active scope) and exposes
 * mutations for the host switcher.
 */
export function useHosts(): UseHostsResult {
	const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const result = await getHubTrpcClient().hosts.list.query();
			setHosts(result.hosts);
			setError(null);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void refresh();
		const timer = window.setInterval(() => {
			if (!cancelled) {
				void refresh();
			}
		}, REFRESH_INTERVAL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [refresh]);

	const addHost = useCallback(
		async (input: RegisterHostInput) => {
			const summary = await getHubTrpcClient().hosts.add.mutate(input);
			await refresh();
			return summary;
		},
		[refresh],
	);

	const updateHost = useCallback(
		async (hostId: string, patch: UpdateHostInput) => {
			const summary = await getHubTrpcClient().hosts.update.mutate({ hostId, patch });
			await refresh();
			return summary;
		},
		[refresh],
	);

	const removeHost = useCallback(
		async (hostId: string) => {
			await getHubTrpcClient().hosts.remove.mutate({ hostId });
			await refresh();
		},
		[refresh],
	);

	const connectHost = useCallback(
		async (hostId: string) => {
			await getHubTrpcClient().hosts.connect.mutate({ hostId });
			await refresh();
		},
		[refresh],
	);

	const disconnectHost = useCallback(
		async (hostId: string) => {
			await getHubTrpcClient().hosts.disconnect.mutate({ hostId });
			await refresh();
		},
		[refresh],
	);

	return { hosts, isLoading, error, refresh, addHost, updateHost, removeHost, connectHost, disconnectHost };
}
