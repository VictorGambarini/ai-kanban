import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Visibility states Claude Code accepts in the `skillOverrides` setting. */
export type ClaudeSkillVisibility = "on" | "name-only" | "user-invocable-only" | "off";

export async function listSkillDirNames(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * Names of skills Claude Code would auto-discover for a session in `worktreePath`,
 * across every personal/user/project root it scans: `~/.claude/skills`,
 * `~/.config/claude/skills`, the cross-agent `~/.agents/skills`, and the worktree's
 * own `.claude/skills` and `.agents/skills`.
 *
 * Bundled skills are handled separately (`disableBundledSkills`). Plugin skills
 * (`<plugin>:<skill>`) are intentionally not enumerated: Claude Code's `skillOverrides`
 * does not hide them, so there is no supported way to scope them per run.
 */
export async function listDiscoverableClaudeSkillNames(worktreePath: string): Promise<string[]> {
	const home = homedir();
	const roots = [
		join(home, ".claude", "skills"),
		join(home, ".config", "claude", "skills"),
		join(home, ".agents", "skills"),
		join(worktreePath, ".claude", "skills"),
		join(worktreePath, ".agents", "skills"),
	];
	const names = new Set<string>();
	for (const root of roots) {
		for (const name of await listSkillDirNames(root)) {
			names.add(name);
		}
	}
	return [...names];
}

/**
 * Builds a `skillOverrides` map that turns every discoverable skill *not* in
 * `selectedNames` to `"off"`, so only the task's selected skills remain visible to
 * Claude. Selected skills are omitted (they default to `"on"`).
 */
export function buildClaudeSkillOverrides(
	discoverableNames: Iterable<string>,
	selectedNames: Iterable<string>,
): Record<string, ClaudeSkillVisibility> {
	const selected = new Set(selectedNames);
	const overrides: Record<string, ClaudeSkillVisibility> = {};
	for (const name of discoverableNames) {
		if (!selected.has(name)) {
			overrides[name] = "off";
		}
	}
	return overrides;
}
