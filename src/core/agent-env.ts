// Hub-central custom environment variables injected into agent task sessions.
//
// These are Kanban-owned env vars the user wants available to CLI agents
// (Claude Code, Codex, …) when a task runs — e.g. GH_TOKEN for `gh`, a Jira API
// key for automations, or custom ANTHROPIC_* overrides. They are deliberately
// resolved on the hub and shipped inside the task-start request body so the
// effective set is identical whether the agent spawns on the local runtime or a
// proxied remote host. Three scopes layer, most specific winning:
//
//   global  <  projects[projectId]  <  tasks[taskId]
//
// Secret values are stored in plaintext in the hub config (chmod 600) per the
// product decision; callers MUST treat resolved values as sensitive and keep
// them out of logs, telemetry, and error messages (see REDACTED_ENV_VALUE).
import { z } from "zod";

/** A flat set of environment variable assignments. */
export type AgentEnvMap = Record<string, string>;

/** The full hub-central env configuration across every scope. */
export interface AgentEnvConfig {
	global: AgentEnvMap;
	projects: Record<string, AgentEnvMap>;
	tasks: Record<string, AgentEnvMap>;
}

/** POSIX-ish env var name: letters/underscore first, then letters/digits/underscore. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
	return ENV_KEY_PATTERN.test(key);
}

/**
 * Coerce an arbitrary record into a clean {@link AgentEnvMap}: trim keys, drop
 * empty/invalid keys, coerce values to strings, and drop entries whose key is
 * not a legal env var name. Values are intentionally NOT trimmed — leading or
 * trailing whitespace can be meaningful in a token.
 */
export function normalizeAgentEnvMap(raw: unknown): AgentEnvMap {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	const normalized: AgentEnvMap = {};
	for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
		const key = rawKey.trim();
		if (!key || !isValidEnvKey(key)) {
			continue;
		}
		if (rawValue === null || rawValue === undefined) {
			continue;
		}
		normalized[key] = typeof rawValue === "string" ? rawValue : String(rawValue);
	}
	return normalized;
}

function normalizeEnvMapRecord(raw: unknown): Record<string, AgentEnvMap> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	const normalized: Record<string, AgentEnvMap> = {};
	for (const [scopeKey, value] of Object.entries(raw as Record<string, unknown>)) {
		const key = scopeKey.trim();
		if (!key) {
			continue;
		}
		const map = normalizeAgentEnvMap(value);
		if (Object.keys(map).length > 0) {
			normalized[key] = map;
		}
	}
	return normalized;
}

export const EMPTY_AGENT_ENV_CONFIG: AgentEnvConfig = {
	global: {},
	projects: {},
	tasks: {},
};

export function normalizeAgentEnvConfig(raw: unknown): AgentEnvConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { global: {}, projects: {}, tasks: {} };
	}
	const source = raw as Record<string, unknown>;
	return {
		global: normalizeAgentEnvMap(source.global),
		projects: normalizeEnvMapRecord(source.projects),
		tasks: normalizeEnvMapRecord(source.tasks),
	};
}

/** True when the config holds no assignments in any scope. */
export function isAgentEnvConfigEmpty(config: AgentEnvConfig): boolean {
	return (
		Object.keys(config.global).length === 0 &&
		Object.keys(config.projects).length === 0 &&
		Object.keys(config.tasks).length === 0
	);
}

/**
 * Merge the three scopes into the effective env map for a task launch. Later
 * (more specific) scopes override earlier ones. `projectId`/`taskId` are
 * optional so non-project contexts (e.g. the home agent) still get global vars.
 */
export function resolveEffectiveAgentEnv(
	config: AgentEnvConfig,
	scope: { projectId?: string | null; taskId?: string | null },
): AgentEnvMap {
	const projectMap = scope.projectId ? (config.projects[scope.projectId] ?? {}) : {};
	const taskMap = scope.taskId ? (config.tasks[scope.taskId] ?? {}) : {};
	return {
		...config.global,
		...projectMap,
		...taskMap,
	};
}

/** Placeholder used when env values must appear in a log/telemetry/error string. */
export const REDACTED_ENV_VALUE = "[redacted]";

/** Redact the values of an env map for safe display, preserving the key set. */
export function redactAgentEnvMap(map: AgentEnvMap): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const key of Object.keys(map)) {
		redacted[key] = REDACTED_ENV_VALUE;
	}
	return redacted;
}

export const agentEnvMapSchema = z.record(z.string(), z.string());

export const agentEnvConfigSchema = z.object({
	global: agentEnvMapSchema.default({}),
	projects: z.record(z.string(), agentEnvMapSchema).default({}),
	tasks: z.record(z.string(), agentEnvMapSchema).default({}),
});
