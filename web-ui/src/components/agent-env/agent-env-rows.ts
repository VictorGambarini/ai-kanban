// Editing helpers that bridge the persisted env *map* and the ordered *rows* the
// editor renders. Maps lose order and make per-row React state awkward (cursor
// jumps, duplicate-key churn), so the UI edits a stable array and converts back
// only when persisting.
import { type AgentEnvMap, isValidEnvKey } from "@runtime-agent-env";

export interface EnvRow {
	/** Stable id for React keys; unrelated to the env var name. */
	id: string;
	key: string;
	value: string;
}

let rowIdCounter = 0;

function nextRowId(): string {
	rowIdCounter += 1;
	return `env-row-${rowIdCounter}`;
}

export function createEnvRow(key = "", value = ""): EnvRow {
	return { id: nextRowId(), key, value };
}

export function mapToRows(map: AgentEnvMap): EnvRow[] {
	return Object.entries(map).map(([key, value]) => createEnvRow(key, value));
}

/**
 * Collapse rows back into a map. Empty keys are dropped; later rows win on
 * duplicate keys (matching how a shell would apply repeated assignments).
 */
export function rowsToMap(rows: EnvRow[]): AgentEnvMap {
	const map: AgentEnvMap = {};
	for (const row of rows) {
		const key = row.key.trim();
		if (!key) {
			continue;
		}
		map[key] = row.value;
	}
	return map;
}

/** A trimmed, non-empty key that is not a legal env var name (for inline warnings). */
export function isInvalidEnvKey(key: string): boolean {
	const trimmed = key.trim();
	return trimmed.length > 0 && !isValidEnvKey(trimmed);
}

/** Keys that appear more than once across rows (case-sensitive), for inline warnings. */
export function findDuplicateEnvKeys(rows: EnvRow[]): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const row of rows) {
		const key = row.key.trim();
		if (!key) {
			continue;
		}
		if (seen.has(key)) {
			duplicates.add(key);
		}
		seen.add(key);
	}
	return duplicates;
}
