// Per-workspace, browser-local memory of how skills are picked for new tasks:
// the last selection (so new tasks repeat it) and cumulative usage counts (so the
// picker can surface most-used skills first). Stored in localStorage, keyed by
// workspace/project id. All access is best-effort and never throws.

const LAST_USED_PREFIX = "kanban.skill-prefs.lastUsed.";
const USAGE_PREFIX = "kanban.skill-prefs.usage.";

function readJson<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) {
			return fallback;
		}
		const parsed: unknown = JSON.parse(raw);
		return isValid(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCountRecord(value: unknown): value is Record<string, number> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((count) => typeof count === "number")
	);
}

/** The skill names selected on the most recent new task in this workspace. */
export function readLastUsedSkillNames(workspaceId: string | null): string[] {
	if (!workspaceId) {
		return [];
	}
	return readJson(`${LAST_USED_PREFIX}${workspaceId}`, [], isStringArray);
}

/** Cumulative per-skill selection counts in this workspace. */
export function readSkillUsageCounts(workspaceId: string | null): Record<string, number> {
	if (!workspaceId) {
		return {};
	}
	return readJson(`${USAGE_PREFIX}${workspaceId}`, {}, isCountRecord);
}

/**
 * Records the selection made when creating a task: stores it as the new "last used"
 * default and increments each selected skill's usage count. Recording an empty
 * selection is intentional — it means the next new task should also start empty.
 */
export function recordSkillSelection(workspaceId: string | null, skillNames: string[]): void {
	if (!workspaceId) {
		return;
	}
	try {
		localStorage.setItem(`${LAST_USED_PREFIX}${workspaceId}`, JSON.stringify(skillNames));
		const counts = readSkillUsageCounts(workspaceId);
		for (const name of skillNames) {
			counts[name] = (counts[name] ?? 0) + 1;
		}
		localStorage.setItem(`${USAGE_PREFIX}${workspaceId}`, JSON.stringify(counts));
	} catch {
		// Best-effort; storage may be unavailable (private mode, quota, SSR).
	}
}
