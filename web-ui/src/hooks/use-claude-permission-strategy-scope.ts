// Hooks for editing one scope of the hub-central Claude permission strategy
// config. Mirrors use-agent-env-scope.ts's split:
//
// `useClaudePermissionStrategyScopeValue` owns only the pending-value editing
// state for a single scope (seed from the stored value, track dirty). It takes
// a pre-selected scope value so a surface that edits several scopes at once
// (Settings: global + project) can drive several of them from one shared
// config load and one save.
//
// `useClaudePermissionStrategyScope` is the batteries-included single-scope
// editor: it loads the hub config itself and persists just its scope back. Use
// it for a self-contained popover (a task's permission-mode button).
import type { ClaudePermissionStrategy, ClaudePermissionStrategyConfig } from "@runtime-claude-permission-strategy";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
	applyClaudePermissionStrategyScope,
	type ClaudePermissionStrategyScopeRef,
	claudePermissionStrategyScopeKey,
	selectClaudePermissionStrategyScope,
} from "@/components/claude-permission/claude-permission-strategy-scope";
import { useClaudePermissionStrategy } from "@/hooks/use-claude-permission-strategy";

export interface UseClaudePermissionStrategyScopeValueResult {
	/** The in-progress edited value (seeded from the stored scope value). */
	value: ClaudePermissionStrategy | null;
	setValue: (value: ClaudePermissionStrategy | null) => void;
	/** True when the edited value differs from the stored scope value. */
	isDirty: boolean;
}

/**
 * Pending-value editing state for a single scope. `storedValue` MUST be a
 * stable reference between renders (from {@link selectClaudePermissionStrategyScope})
 * — the pending value reseeds whenever it changes, so an unstable reference
 * would clobber in-progress edits.
 */
export function useClaudePermissionStrategyScopeValue(
	storedValue: ClaudePermissionStrategy | null,
): UseClaudePermissionStrategyScopeValueResult {
	const [pendingValue, setPendingValue] = useState<ClaudePermissionStrategy | null>(storedValue);

	// Re-seed when the stored scope value changes (config (re)loads or is saved).
	useEffect(() => {
		setPendingValue(storedValue);
	}, [storedValue]);

	return {
		value: pendingValue,
		setValue: setPendingValue,
		isDirty: pendingValue !== storedValue,
	};
}

export interface UseClaudePermissionStrategyScopeResult extends UseClaudePermissionStrategyScopeValueResult {
	isLoading: boolean;
	isSaving: boolean;
	isError: boolean;
	/** Persist the edited value into this scope of the hub config; returns the saved config or null. */
	save: () => Promise<ClaudePermissionStrategyConfig | null>;
}

/**
 * Self-contained editor for one scope: loads the hub-central config (gated on
 * `enabled`) and persists just this scope back, leaving the other scopes intact.
 */
export function useClaudePermissionStrategyScope(
	scope: ClaudePermissionStrategyScopeRef,
	enabled: boolean,
): UseClaudePermissionStrategyScopeResult {
	const { config, isLoading, isSaving, isError, save: saveConfig } = useClaudePermissionStrategy(enabled);
	// Key everything off the scope's string identity, not the `scope` object — callers
	// pass a fresh `{ kind, ... }` literal each render.
	const scopeKey = claudePermissionStrategyScopeKey(scope);
	const storedValue = useMemo(() => selectClaudePermissionStrategyScope(config, scope), [config, scopeKey]);
	const valueState = useClaudePermissionStrategyScopeValue(storedValue);
	const { value } = valueState;

	const save = useCallback(
		() => saveConfig(applyClaudePermissionStrategyScope(config, scope, value)),
		[saveConfig, config, scopeKey, value],
	);

	return { ...valueState, isLoading, isSaving, isError, save };
}
