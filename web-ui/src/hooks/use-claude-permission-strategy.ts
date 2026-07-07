import type { ClaudePermissionStrategyConfig } from "@runtime-claude-permission-strategy";
import { useCallback, useState } from "react";

import {
	fetchClaudePermissionStrategyConfig,
	saveClaudePermissionStrategyConfig,
} from "@/runtime/claude-permission-strategy-query";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const EMPTY_CONFIG: ClaudePermissionStrategyConfig = { global: null, projects: {}, tasks: {} };

export interface UseClaudePermissionStrategyResult {
	config: ClaudePermissionStrategyConfig;
	isLoading: boolean;
	isError: boolean;
	isSaving: boolean;
	refresh: () => void;
	/** Persist a new config (hub-central) and update local state with the saved result. */
	save: (next: ClaudePermissionStrategyConfig) => Promise<ClaudePermissionStrategyConfig | null>;
}

/**
 * Loads and persists the hub-central Claude Code permission strategy config.
 * Always targets the hub (via {@link fetchClaudePermissionStrategyConfig}), so
 * the same config backs local and remote tasks. `enabled` gates fetching so
 * closed dialogs/popovers don't query.
 */
export function useClaudePermissionStrategy(enabled: boolean): UseClaudePermissionStrategyResult {
	const [isSaving, setIsSaving] = useState(false);
	const queryFn = useCallback(async () => await fetchClaudePermissionStrategyConfig(), []);
	const query = useTrpcQuery<ClaudePermissionStrategyConfig>({ enabled, queryFn, retainDataOnError: true });
	const setData = query.setData;

	const save = useCallback(
		async (next: ClaudePermissionStrategyConfig): Promise<ClaudePermissionStrategyConfig | null> => {
			setIsSaving(true);
			try {
				const saved = await saveClaudePermissionStrategyConfig(next);
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
