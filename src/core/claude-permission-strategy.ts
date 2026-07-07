// Hub-central Claude Code permission strategy: whether autonomous Claude Code
// task launches use a hard permission bypass or Claude Code's newer, safer
// "auto" mode. Three scopes layer, most specific winning outright (this is a
// pick, not a merge like agent-env.ts's env maps, since each scope holds a
// single value rather than a set of keys):
//
//   global  <  projects[projectId]  <  tasks[taskId]
//
// Persisted only in the hub's global config (see runtime-config.ts), the same
// way agent-env.ts's per-project/per-task maps are — "project scope" here
// means "keyed by workspace id inside the one hub-central file," not stored
// in that project's own .cline/kanban/config.json.
import { z } from "zod";

export type ClaudePermissionStrategy = "bypass" | "auto";

/** Preserves pre-existing behavior: unset resolves to a hard permission bypass. */
export const DEFAULT_CLAUDE_PERMISSION_STRATEGY: ClaudePermissionStrategy = "bypass";

/** The full hub-central permission-strategy configuration across every scope. */
export interface ClaudePermissionStrategyConfig {
	global: ClaudePermissionStrategy | null;
	projects: Record<string, ClaudePermissionStrategy>;
	tasks: Record<string, ClaudePermissionStrategy>;
}

export const EMPTY_CLAUDE_PERMISSION_STRATEGY_CONFIG: ClaudePermissionStrategyConfig = {
	global: null,
	projects: {},
	tasks: {},
};

function isClaudePermissionStrategy(value: unknown): value is ClaudePermissionStrategy {
	return value === "bypass" || value === "auto";
}

export function normalizeClaudePermissionStrategy(raw: unknown): ClaudePermissionStrategy | null {
	return isClaudePermissionStrategy(raw) ? raw : null;
}

function normalizeClaudePermissionStrategyRecord(raw: unknown): Record<string, ClaudePermissionStrategy> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	const normalized: Record<string, ClaudePermissionStrategy> = {};
	for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
		const key = rawKey.trim();
		if (!key) {
			continue;
		}
		const value = normalizeClaudePermissionStrategy(rawValue);
		if (value) {
			normalized[key] = value;
		}
	}
	return normalized;
}

export function normalizeClaudePermissionStrategyConfig(raw: unknown): ClaudePermissionStrategyConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { global: null, projects: {}, tasks: {} };
	}
	const source = raw as Record<string, unknown>;
	return {
		global: normalizeClaudePermissionStrategy(source.global),
		projects: normalizeClaudePermissionStrategyRecord(source.projects),
		tasks: normalizeClaudePermissionStrategyRecord(source.tasks),
	};
}

/** True when the config holds no explicit choice in any scope. */
export function isClaudePermissionStrategyConfigEmpty(config: ClaudePermissionStrategyConfig): boolean {
	return config.global === null && Object.keys(config.projects).length === 0 && Object.keys(config.tasks).length === 0;
}

/**
 * Resolve the effective strategy for a launch: the most specific scope with
 * an explicit choice wins outright (task, then project, then global), falling
 * back to {@link DEFAULT_CLAUDE_PERMISSION_STRATEGY} when nothing is set.
 * `projectId`/`taskId` are optional so non-project contexts (e.g. the home
 * agent) still resolve a value from global.
 */
export function resolveEffectiveClaudePermissionStrategy(
	config: ClaudePermissionStrategyConfig,
	scope: { projectId?: string | null; taskId?: string | null },
): ClaudePermissionStrategy {
	const taskValue = scope.taskId ? config.tasks[scope.taskId] : undefined;
	if (taskValue) {
		return taskValue;
	}
	const projectValue = scope.projectId ? config.projects[scope.projectId] : undefined;
	if (projectValue) {
		return projectValue;
	}
	return config.global ?? DEFAULT_CLAUDE_PERMISSION_STRATEGY;
}

export const claudePermissionStrategySchema = z.enum(["bypass", "auto"]);

export const claudePermissionStrategyConfigSchema = z.object({
	global: claudePermissionStrategySchema.nullable().default(null),
	projects: z.record(z.string(), claudePermissionStrategySchema).default({}),
	tasks: z.record(z.string(), claudePermissionStrategySchema).default({}),
});
