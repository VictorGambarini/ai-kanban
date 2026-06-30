import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getGitStdout } from "./git-utils";

const BLOCK_START = "# kanban-managed-skill-paths:start";
const BLOCK_END = "# kanban-managed-skill-paths:end";

// Root-anchored patterns for the files Kanban injects/installs for skills. Listing
// them in the repo's info/exclude hides the untracked copies from task diffs and keeps
// them from being committed, without touching the user's tracked .gitignore. Because
// git excludes only affect untracked files, any skills the project legitimately tracks
// still show up normally.
const SKILL_EXCLUDE_PATTERNS = [
	"/.agents/skills/",
	"/.claude/skills/",
	"/.claude/settings.local.json",
	"/.cline/skills/",
	"/.clinerules/skills/",
	"/CLAUDE.local.md",
	"/skills-lock.json",
];

/**
 * Ensures the repo's `.git/info/exclude` ignores Kanban's injected/installed skill
 * files. `info/exclude` lives in the shared git common dir, so a single call covers the
 * main checkout and every task worktree. No-ops outside a git repo.
 */
export async function ensureSkillGitExcludes(repoPath: string): Promise<void> {
	let excludePathOutput: string;
	try {
		excludePathOutput = (await getGitStdout(["rev-parse", "--git-path", "info/exclude"], repoPath)).trim();
	} catch {
		return;
	}
	if (!excludePathOutput) {
		return;
	}
	const excludePath = isAbsolute(excludePathOutput) ? excludePathOutput : join(repoPath, excludePathOutput);

	const existing = await readFile(excludePath, "utf8").catch(() => "");
	if (existing.includes(BLOCK_START)) {
		return;
	}

	const block = [
		BLOCK_START,
		"# Hide Kanban-injected skill files from task diffs.",
		...SKILL_EXCLUDE_PATTERNS,
		BLOCK_END,
	].join("\n");
	const trimmed = existing.replace(/\n+$/, "");
	const nextContent = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
	await lockedFileSystem.writeTextFileAtomic(excludePath, nextContent);
}
