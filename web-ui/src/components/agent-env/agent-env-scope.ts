// Pure operations on a single scope of the hub-central agent env config.
//
// The config layers three scopes (global < project < task). Every editor surface
// needs the same three operations on its scope: read the scope's map, splice an
// edited map back into the full config (dropping the scope entirely when empty so
// the persisted config stays minimal), and compare two maps for equality. These
// were re-implemented per surface — including the easy-to-get-wrong delete-when-empty
// rule — so they live here once, pure and unit-testable.
import type { AgentEnvConfig, AgentEnvMap } from "@runtime-agent-env";

export type AgentEnvScopeRef =
	| { kind: "global" }
	| { kind: "project"; projectId: string | null }
	| { kind: "task"; taskId: string };

/** A stable string identity for a scope, suitable for React effect/memo deps. */
export function agentEnvScopeKey(scope: AgentEnvScopeRef): string {
	switch (scope.kind) {
		case "global":
			return "global";
		case "project":
			return `project:${scope.projectId ?? ""}`;
		case "task":
			return `task:${scope.taskId}`;
	}
}

/** The map currently stored for a scope (empty when unset, or when a project scope has no id). */
export function selectAgentEnvScope(config: AgentEnvConfig, scope: AgentEnvScopeRef): AgentEnvMap {
	switch (scope.kind) {
		case "global":
			return config.global;
		case "project":
			return scope.projectId ? (config.projects[scope.projectId] ?? {}) : {};
		case "task":
			return config.tasks[scope.taskId] ?? {};
	}
}

/**
 * Return a new config with `map` written into `scope`. An empty map deletes the
 * scope entry (global is always present but cleared) so the persisted config never
 * accrues empty `{}` placeholders. Other scopes are left untouched.
 */
export function applyAgentEnvScope(config: AgentEnvConfig, scope: AgentEnvScopeRef, map: AgentEnvMap): AgentEnvConfig {
	if (scope.kind === "global") {
		return { ...config, global: map };
	}
	if (scope.kind === "project") {
		if (!scope.projectId) {
			return config;
		}
		const projects = { ...config.projects };
		if (Object.keys(map).length > 0) {
			projects[scope.projectId] = map;
		} else {
			delete projects[scope.projectId];
		}
		return { ...config, projects };
	}
	const tasks = { ...config.tasks };
	if (Object.keys(map).length > 0) {
		tasks[scope.taskId] = map;
	} else {
		delete tasks[scope.taskId];
	}
	return { ...config, tasks };
}

/** Shallow value-equality of two env maps (same keys, same values). */
export function agentEnvMapsEqual(a: AgentEnvMap, b: AgentEnvMap): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) {
		return false;
	}
	return aKeys.every((key) => a[key] === b[key]);
}
