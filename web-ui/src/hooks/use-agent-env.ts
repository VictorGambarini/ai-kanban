import type { AgentEnvConfig } from "@runtime-agent-env";
import { useCallback, useState } from "react";

import { fetchAgentEnvConfig, saveAgentEnvConfig } from "@/runtime/runtime-config-query";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const EMPTY_CONFIG: AgentEnvConfig = { global: {}, projects: {}, tasks: {} };

export interface UseAgentEnvResult {
	config: AgentEnvConfig;
	isLoading: boolean;
	isError: boolean;
	isSaving: boolean;
	refresh: () => void;
	/** Persist a new config (hub-central) and update local state with the saved result. */
	save: (next: AgentEnvConfig) => Promise<AgentEnvConfig | null>;
}

/**
 * Loads and persists the hub-central agent env config. Always targets the hub
 * (via {@link fetchAgentEnvConfig}), so the same config backs local and remote
 * tasks. `enabled` gates fetching so closed dialogs/popovers don't query.
 */
export function useAgentEnv(enabled: boolean): UseAgentEnvResult {
	const [isSaving, setIsSaving] = useState(false);
	const queryFn = useCallback(async () => await fetchAgentEnvConfig(), []);
	const query = useTrpcQuery<AgentEnvConfig>({ enabled, queryFn, retainDataOnError: true });
	const setData = query.setData;

	const save = useCallback(
		async (next: AgentEnvConfig): Promise<AgentEnvConfig | null> => {
			setIsSaving(true);
			try {
				const saved = await saveAgentEnvConfig(next);
				setData(saved);
				return saved;
			} finally {
				setIsSaving(false);
			}
		},
		[setData],
	);

	const refresh = useCallback(() => {
		void query.refetch();
	}, [query.refetch]);

	return {
		config: query.data ?? EMPTY_CONFIG,
		isLoading: enabled && query.isLoading && query.data === null,
		isError: query.isError,
		isSaving,
		refresh,
		save,
	};
}
