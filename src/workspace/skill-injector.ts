import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeAgentId, RuntimeWorkspaceSkill } from "../core/api-contract";
import { ensureSkillGitExcludes } from "./skill-git-exclude";
import { buildClaudeSkillOverrides, listDiscoverableClaudeSkillNames, listSkillDirNames } from "./skill-isolation";
import { listSkills } from "./workspace-skill-service";

const KANBAN_SKILLS_START = "<!-- kanban-skills-start -->";
const KANBAN_SKILLS_END = "<!-- kanban-skills-end -->";

interface SkillInjector {
	// Applies the desired skill set as the worktree's source of truth: copies in the
	// selected skills and removes any previously Kanban-managed skills no longer desired.
	apply(worktreePath: string, workspacePath: string, desiredSkillNames: string[]): Promise<void>;
}

async function copySkillDir(srcDir: string, destDir: string): Promise<void> {
	await mkdir(destDir, { recursive: true });
	await cp(srcDir, destDir, { recursive: true, force: true });
}

// Resolve enabled, desired skills to their source directories from a pre-fetched
// workspace skill list (avoids re-shelling the `npx skills` CLI per call).
function resolveSkillDirs(skills: RuntimeWorkspaceSkill[], skillNames: string[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const name of skillNames) {
		const skill = skills.find((s) => s.name === name && !s.disabled);
		if (skill?.dirPath) {
			result.set(name, skill.dirPath);
		}
	}
	return result;
}

// Remove worktree skill dirs that Kanban previously injected (i.e. whose name maps to a
// known workspace skill) but that are no longer desired. User-authored skill dirs that
// don't correspond to a workspace skill are left untouched.
async function removeManagedSkillDirs(
	roots: string[],
	workspaceSkillNames: Set<string>,
	desired: Set<string>,
): Promise<void> {
	for (const root of roots) {
		for (const name of await listSkillDirNames(root)) {
			if (workspaceSkillNames.has(name) && !desired.has(name)) {
				await rm(join(root, name), { recursive: true, force: true });
			}
		}
	}
}

class ClineSkillInjector implements SkillInjector {
	async apply(worktreePath: string, workspacePath: string, desiredSkillNames: string[]): Promise<void> {
		const skills = await listSkills(workspacePath);
		const workspaceSkillNames = new Set(skills.map((s) => s.name));
		const desired = new Set(desiredSkillNames);
		const agentsRoot = join(worktreePath, ".agents", "skills");

		await removeManagedSkillDirs([agentsRoot], workspaceSkillNames, desired);
		for (const [name, srcDir] of resolveSkillDirs(skills, desiredSkillNames)) {
			await copySkillDir(srcDir, join(agentsRoot, name));
		}
	}
}

class ClaudeSkillInjector implements SkillInjector {
	async apply(worktreePath: string, workspacePath: string, desiredSkillNames: string[]): Promise<void> {
		const skills = await listSkills(workspacePath);
		const workspaceSkillNames = new Set(skills.map((s) => s.name));
		const desired = new Set(desiredSkillNames);
		const agentsRoot = join(worktreePath, ".agents", "skills");
		const claudeRoot = join(worktreePath, ".claude", "skills");

		await removeManagedSkillDirs([agentsRoot, claudeRoot], workspaceSkillNames, desired);
		const skillDirs = resolveSkillDirs(skills, desiredSkillNames);
		for (const [name, srcDir] of skillDirs) {
			await copySkillDir(srcDir, join(agentsRoot, name));
			await copySkillDir(srcDir, join(claudeRoot, name));
		}
		const selectedNames = [...skillDirs.keys()];
		await this.writeClaudeLocalMd(worktreePath, selectedNames);
		await this.writeSkillOverrides(worktreePath, selectedNames);
	}

	// Hide every other skill Claude would auto-discover (personal + project + bundled)
	// so only the task's selected skills are visible, via project-scoped settings.
	private async writeSkillOverrides(worktreePath: string, selectedNames: string[]): Promise<void> {
		const discoverable = await listDiscoverableClaudeSkillNames(worktreePath);
		const overrides = buildClaudeSkillOverrides(discoverable, selectedNames);

		const settingsPath = join(worktreePath, ".claude", "settings.local.json");
		let existing: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
			if (parsed && typeof parsed === "object") {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			// No existing settings (or unparseable) — start fresh.
		}

		const existingOverrides =
			existing.skillOverrides && typeof existing.skillOverrides === "object"
				? (existing.skillOverrides as Record<string, unknown>)
				: {};
		// Re-selecting a previously hidden skill must clear its stale "off" entry so it
		// becomes visible again on a later sync. Drop managed "off" entries for now-selected
		// skills; keep any other (user-authored) overrides untouched.
		const selected = new Set(selectedNames);
		const preserved: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(existingOverrides)) {
			if (selected.has(name) && value === "off") {
				continue;
			}
			preserved[name] = value;
		}
		const merged = {
			...existing,
			disableBundledSkills: true,
			skillOverrides: { ...preserved, ...overrides },
		};

		await mkdir(join(worktreePath, ".claude"), { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	}

	private async writeClaudeLocalMd(worktreePath: string, skillNames: string[]): Promise<void> {
		const localMdPath = join(worktreePath, "CLAUDE.local.md");
		let existing = "";
		try {
			existing = await readFile(localMdPath, "utf8");
		} catch {
			// File doesn't exist yet — start fresh.
		}

		const skillsBlock = this.buildSkillsBlock(skillNames);

		let updated: string;
		const startIdx = existing.indexOf(KANBAN_SKILLS_START);
		const endIdx = existing.indexOf(KANBAN_SKILLS_END);
		if (startIdx !== -1 && endIdx !== -1) {
			updated = existing.slice(0, startIdx) + skillsBlock + existing.slice(endIdx + KANBAN_SKILLS_END.length);
		} else if (skillsBlock) {
			updated = existing ? `${existing.trimEnd()}\n\n${skillsBlock}` : skillsBlock;
		} else {
			updated = existing;
		}

		await writeFile(localMdPath, updated, "utf8");
	}

	private buildSkillsBlock(skillNames: string[]): string {
		if (skillNames.length === 0) {
			return "";
		}
		const lines = [
			KANBAN_SKILLS_START,
			"## Available Skills",
			"Skills for this task are in `.claude/skills/` — read and follow them when relevant to the task.",
			"",
			...skillNames.map((name) => `- **${name}**: \`.claude/skills/${name}/SKILL.md\``),
			KANBAN_SKILLS_END,
		];
		return lines.join("\n") + "\n";
	}
}

const SKILL_INJECTORS: Partial<Record<RuntimeAgentId, SkillInjector>> = {
	cline: new ClineSkillInjector(),
	claude: new ClaudeSkillInjector(),
};

// Add the selected skills to a task worktree before its agent starts. Add-only: an empty
// selection is a no-op so a fresh worktree is never touched needlessly.
export async function injectSkillsForAgent(
	agentId: RuntimeAgentId,
	worktreePath: string,
	workspacePath: string,
	skillNames: string[],
): Promise<void> {
	if (skillNames.length === 0) {
		return;
	}
	const injector = SKILL_INJECTORS[agentId];
	if (!injector) {
		return;
	}
	await injector.apply(worktreePath, workspacePath, skillNames);
	// Keep injected skill files out of the task diff. info/exclude is shared across the
	// common git dir, so passing the workspace repo also covers every worktree.
	await ensureSkillGitExcludes(workspacePath);
}

// Make a running task's worktree match the desired skill set exactly: copies in newly
// selected skills and removes ones that were deselected. Unlike injectSkillsForAgent this
// applies an empty selection too, so it can clear all Kanban-managed skills.
export async function syncSkillsForAgent(
	agentId: RuntimeAgentId,
	worktreePath: string,
	workspacePath: string,
	desiredSkillNames: string[],
): Promise<void> {
	const injector = SKILL_INJECTORS[agentId];
	if (!injector) {
		return;
	}
	await injector.apply(worktreePath, workspacePath, desiredSkillNames);
	await ensureSkillGitExcludes(workspacePath);
}
