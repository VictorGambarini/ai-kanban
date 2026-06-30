// Hooks for editing one scope of the hub-central agent env config.
//
// `useAgentEnvScopeRows` owns only the row<->map editing state for a single scope
// (seed rows from the stored map, track dirty, count vars). It takes a pre-selected
// scope map so a surface that edits several scopes at once (Settings: global +
// project) can drive several of them from one shared config load and one save.
//
// `useAgentEnvScope` is the batteries-included single-scope editor: it loads the
// hub config itself and persists just its scope back. Use it for a self-contained
// popover (a task's env button).
import type { AgentEnvConfig, AgentEnvMap } from "@runtime-agent-env";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type EnvRow, mapToRows, rowsToMap } from "@/components/agent-env/agent-env-rows";
import {
	type AgentEnvScopeRef,
	agentEnvMapsEqual,
	agentEnvScopeKey,
	applyAgentEnvScope,
	selectAgentEnvScope,
} from "@/components/agent-env/agent-env-scope";
import { useAgentEnv } from "@/hooks/use-agent-env";

export interface UseAgentEnvScopeRowsResult {
	rows: EnvRow[];
	setRows: (rows: EnvRow[]) => void;
	/** True when the edited rows differ from the stored scope map. */
	isDirty: boolean;
	/** Number of variables currently stored in the scope (not counting unsaved edits). */
	varCount: number;
}

/**
 * Row editing state for a single scope. `scopeMap` MUST be a stable reference
 * between renders (memoize it via {@link selectAgentEnvScope}) — the rows reseed
 * whenever it changes, so an unstable reference would clobber in-progress edits.
 */
export function useAgentEnvScopeRows(scopeMap: AgentEnvMap): UseAgentEnvScopeRowsResult {
	const [rows, setRows] = useState<EnvRow[]>(() => mapToRows(scopeMap));

	// Re-seed when the stored scope map changes (config (re)loads or is saved).
	useEffect(() => {
		setRows(mapToRows(scopeMap));
	}, [scopeMap]);

	const isDirty = !agentEnvMapsEqual(rowsToMap(rows), scopeMap);
	const varCount = Object.keys(scopeMap).length;

	return { rows, setRows, isDirty, varCount };
}

export interface UseAgentEnvScopeResult extends UseAgentEnvScopeRowsResult {
	isLoading: boolean;
	isSaving: boolean;
	isError: boolean;
	/** Persist the edited rows into this scope of the hub config; returns the saved config or null. */
	save: () => Promise<AgentEnvConfig | null>;
}

/**
 * Self-contained editor for one scope: loads the hub-central config (gated on
 * `enabled`) and persists just this scope back, leaving the other scopes intact.
 */
export function useAgentEnvScope(scope: AgentEnvScopeRef, enabled: boolean): UseAgentEnvScopeResult {
	const { config, isLoading, isSaving, isError, save: saveConfig } = useAgentEnv(enabled);
	// Key everything off the scope's string identity, not the `scope` object — callers
	// pass a fresh `{ kind, ... }` literal each render. Re-selecting only when the
	// identity (or config) changes keeps the rows hook from reseeding mid-edit. Two
	// `scope` objects with the same key are interchangeable for both reads below.
	const scopeKey = agentEnvScopeKey(scope);
	const scopeMap = useMemo(() => selectAgentEnvScope(config, scope), [config, scopeKey]);
	const rowsState = useAgentEnvScopeRows(scopeMap);
	const { rows } = rowsState;

	const save = useCallback(
		() => saveConfig(applyAgentEnvScope(config, scope, rowsToMap(rows))),
		[saveConfig, config, scopeKey, rows],
	);

	return { ...rowsState, isLoading, isSaving, isError, save };
}
