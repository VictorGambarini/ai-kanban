// Pure operations on a single scope of the hub-central Claude permission
// strategy config. Mirrors agent-env-scope.ts's shape, but each scope holds a
// single value (or "unset") rather than a map of keys, so writing back clears
// the scope entirely when the caller picks "use the less specific default"
// instead of an explicit choice.
import type { ClaudePermissionStrategy, ClaudePermissionStrategyConfig } from "@runtime-claude-permission-strategy";

export type ClaudePermissionStrategyScopeRef =
	| { kind: "global" }
	| { kind: "project"; projectId: string | null }
	| { kind: "task"; taskId: string };

/** A stable string identity for a scope, suitable for React effect/memo deps. */
export function claudePermissionStrategyScopeKey(scope: ClaudePermissionStrategyScopeRef): string {
	switch (scope.kind) {
		case "global":
			return "global";
		case "project":
			return `project:${scope.projectId ?? ""}`;
		case "task":
			return `task:${scope.taskId}`;
	}
}

/** The explicit choice stored for a scope, or null when unset (falls back to the next scope up). */
export function selectClaudePermissionStrategyScope(
	config: ClaudePermissionStrategyConfig,
	scope: ClaudePermissionStrategyScopeRef,
): ClaudePermissionStrategy | null {
	switch (scope.kind) {
		case "global":
			return config.global;
		case "project":
			return scope.projectId ? (config.projects[scope.projectId] ?? null) : null;
		case "task":
			return config.tasks[scope.taskId] ?? null;
	}
}

/**
 * Return a new config with `value` written into `scope`. `null` clears the
 * scope entry (falling back to the next scope up) so the persisted config
 * never accrues redundant explicit choices. Other scopes are left untouched.
 */
export function applyClaudePermissionStrategyScope(
	config: ClaudePermissionStrategyConfig,
	scope: ClaudePermissionStrategyScopeRef,
	value: ClaudePermissionStrategy | null,
): ClaudePermissionStrategyConfig {
	if (scope.kind === "global") {
		return { ...config, global: value };
	}
	if (scope.kind === "project") {
		if (!scope.projectId) {
			return config;
		}
		const projects = { ...config.projects };
		if (value) {
			projects[scope.projectId] = value;
		} else {
			delete projects[scope.projectId];
		}
		return { ...config, projects };
	}
	const tasks = { ...config.tasks };
	if (value) {
		tasks[scope.taskId] = value;
	} else {
		delete tasks[scope.taskId];
	}
	return { ...config, tasks };
}
