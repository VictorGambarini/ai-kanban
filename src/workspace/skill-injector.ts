import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeAgentId } from "../core/api-contract";
import { ensureSkillGitExcludes } from "./skill-git-exclude";
import { buildClaudeSkillOverrides, listDiscoverableClaudeSkillNames } from "./skill-isolation";
import { listSkills } from "./workspace-skill-service";

const KANBAN_SKILLS_START = "<!-- kanban-skills-start -->";
const KANBAN_SKILLS_END = "<!-- kanban-skills-end -->";

interface SkillInjector {
	inject(worktreePath: string, workspacePath: string, skillNames: string[]): Promise<void>;
}

async function copySkillDir(srcDir: string, destDir: string): Promise<void> {
	await mkdir(destDir, { recursive: true });
	await cp(srcDir, destDir, { recursive: true, force: true });
}

async function resolveSkillDirs(workspacePath: string, skillNames: string[]): Promise<Map<string, string>> {
	const skills = await listSkills(workspacePath);
	const result = new Map<string, string>();
	for (const name of skillNames) {
		const skill = skills.find((s) => s.name === name && !s.disabled);
		if (skill?.dirPath) {
			result.set(name, skill.dirPath);
		}
	}
	return result;
}

class ClineSkillInjector implements SkillInjector {
	async inject(worktreePath: string, workspacePath: string, skillNames: string[]): Promise<void> {
		const skillDirs = await resolveSkillDirs(workspacePath, skillNames);
		for (const [name, srcDir] of skillDirs) {
			const destDir = join(worktreePath, ".agents", "skills", name);
			await copySkillDir(srcDir, destDir);
		}
	}
}

class ClaudeSkillInjector implements SkillInjector {
	async inject(worktreePath: string, workspacePath: string, skillNames: string[]): Promise<void> {
		const skillDirs = await resolveSkillDirs(workspacePath, skillNames);
		for (const [name, srcDir] of skillDirs) {
			await copySkillDir(srcDir, join(worktreePath, ".agents", "skills", name));
			await copySkillDir(srcDir, join(worktreePath, ".claude", "skills", name));
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
		const merged = {
			...existing,
			disableBundledSkills: true,
			skillOverrides: { ...existingOverrides, ...overrides },
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
		} else {
			updated = existing ? `${existing.trimEnd()}\n\n${skillsBlock}` : skillsBlock;
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

export async function injectSkillsForAgent(
	agentId: RuntimeAgentId,
	worktreePath: string,
	workspacePath: string,
	skillNames: string[],
): Promise<void> {
	if (skillNames.length === 0) {
		return;
	}
	await SKILL_INJECTORS[agentId]?.inject(worktreePath, workspacePath, skillNames);
	// Keep injected skill files out of the task diff. info/exclude is shared across the
	// common git dir, so passing the workspace repo also covers every worktree.
	await ensureSkillGitExcludes(workspacePath);
}
