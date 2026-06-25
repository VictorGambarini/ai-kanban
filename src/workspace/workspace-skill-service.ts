import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseSkillsShSource, type RuntimeWorkspaceSkill } from "../core/api-contract";

const execFileAsync = promisify(execFile);

async function runSubprocess(binary: string, args: string[], options: { cwd: string }): Promise<string> {
	const { stdout } = await execFileAsync(binary, args, { cwd: options.cwd, env: process.env });
	return stdout;
}

const SKILL_MAIN_FILE = "SKILL.md";

interface SkillsCliListEntry {
	name: string;
	path: string;
	scope: string;
	agents: string[];
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter = Record<string, unknown>;

function splitFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) {
		return { frontmatter: {}, body: content };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(match[1]);
	} catch {
		parsed = null;
	}
	const frontmatter = parsed && typeof parsed === "object" ? (parsed as SkillFrontmatter) : {};
	return { frontmatter, body: content.slice(match[0].length) };
}

function serializeSkill(frontmatter: SkillFrontmatter, body: string): string {
	const yaml = stringifyYaml(frontmatter).trimEnd();
	const trimmedBody = body.replace(/^\r?\n+/, "");
	return `---\n${yaml}\n---\n\n${trimmedBody}`;
}

function parseSkillFrontmatter(content: string): {
	description?: string;
	disabled?: boolean;
	installedFrom?: string;
	installedAt?: string;
} {
	const { frontmatter } = splitFrontmatter(content);
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;
	const disabled = typeof frontmatter.disabled === "boolean" ? frontmatter.disabled : undefined;
	const installedFrom = typeof frontmatter.installedFrom === "string" ? frontmatter.installedFrom.trim() : undefined;
	const installedAt = typeof frontmatter.installedAt === "string" ? frontmatter.installedAt.trim() : undefined;
	return {
		description: description || undefined,
		disabled,
		installedFrom: installedFrom || undefined,
		installedAt: installedAt || undefined,
	};
}

function setFrontmatterField(content: string, field: string, value: unknown): string {
	const { frontmatter, body } = splitFrontmatter(content);
	frontmatter[field] = value;
	return serializeSkill(frontmatter, body);
}

async function readSkillMeta(
	skillPath: string,
): Promise<{ description?: string; disabled: boolean; installedFrom?: string; installedAt?: string }> {
	try {
		const content = await readFile(join(skillPath, SKILL_MAIN_FILE), "utf8");
		const parsed = parseSkillFrontmatter(content);
		return {
			description: parsed.description,
			disabled: parsed.disabled === true,
			installedFrom: parsed.installedFrom,
			installedAt: parsed.installedAt,
		};
	} catch {
		return { disabled: false };
	}
}

export async function listSkills(workspacePath: string): Promise<RuntimeWorkspaceSkill[]> {
	const results: RuntimeWorkspaceSkill[] = [];
	for (const scope of ["-p", "-g"] as const) {
		let stdout: string;
		try {
			stdout = await runSubprocess("npx", ["skills", "list", "--json", scope], { cwd: workspacePath });
		} catch {
			continue;
		}
		let entries: SkillsCliListEntry[];
		try {
			entries = JSON.parse(stdout.trim());
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (results.some((r) => r.name === entry.name)) {
				continue;
			}
			const meta = await readSkillMeta(entry.path);
			results.push({
				name: entry.name,
				description: meta.description,
				disabled: meta.disabled,
				dirPath: entry.path,
				installedFrom: meta.installedFrom,
				installedAt: meta.installedAt,
			});
		}
	}
	return results;
}

export async function installSkill(workspacePath: string, source: string, skillNames?: string[]): Promise<void> {
	const { repo, skill } = parseSkillsShSource(source);
	// A skill named directly in the source URL acts as a default filter, but an explicit
	// skillNames argument from the caller takes precedence.
	const effectiveSkillNames = skillNames && skillNames.length > 0 ? skillNames : skill ? [skill] : [];

	const before = new Set((await listSkills(workspacePath)).map((s) => s.name));

	const args = ["skills", "add", repo, "--agent", "claude-code", "--agent", "cline", "--copy", "--yes", "-p"];
	for (const name of effectiveSkillNames) {
		args.push("--skill", name);
	}
	await runSubprocess("npx", args, { cwd: workspacePath });

	await stampInstallMetadata(workspacePath, repo, before);
}

/** Stamps installedFrom/installedAt frontmatter onto skills that appeared after an install. */
async function stampInstallMetadata(workspacePath: string, repo: string, before: Set<string>): Promise<void> {
	const installedAt = new Date().toISOString();
	const after = await listSkills(workspacePath);
	await Promise.all(
		after
			.filter((skill) => !before.has(skill.name) && skill.dirPath)
			.map(async (skill) => {
				try {
					const skillMdPath = join(skill.dirPath, SKILL_MAIN_FILE);
					const content = await readFile(skillMdPath, "utf8");
					let updated = setFrontmatterField(content, "installedFrom", repo);
					updated = setFrontmatterField(updated, "installedAt", installedAt);
					await writeFile(skillMdPath, updated, "utf8");
				} catch {
					// Best-effort metadata; a failure here must not fail the install.
				}
			}),
	);
}

export async function removeSkill(workspacePath: string, name: string): Promise<void> {
	try {
		await runSubprocess("npx", ["skills", "remove", name, "--yes", "-p"], { cwd: workspacePath });
	} catch {
		// Skills CLI may error if skill not found at project scope; try direct removal.
		const skills = await listSkills(workspacePath);
		const skill = skills.find((s) => s.name === name);
		if (skill?.dirPath) {
			await rm(skill.dirPath, { recursive: true, force: true });
		}
	}
}

export async function createSkill(
	workspacePath: string,
	{ name, description, instructions }: { name: string; description?: string; instructions: string },
): Promise<void> {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const skillDir = join(workspacePath, ".agents", "skills", slug);
	await mkdir(skillDir, { recursive: true });
	const frontmatter: SkillFrontmatter = { name: slug };
	if (description?.trim()) {
		frontmatter.description = description.trim();
	}
	const content = `${serializeSkill(frontmatter, instructions.trim())}\n`;
	await writeFile(join(skillDir, SKILL_MAIN_FILE), content, "utf8");
}

export async function setSkillDisabled(workspacePath: string, name: string, disabled: boolean): Promise<void> {
	const skills = await listSkills(workspacePath);
	const skill = skills.find((s) => s.name === name);
	if (!skill?.dirPath) {
		throw new Error(`Skill "${name}" not found`);
	}
	const skillMdPath = join(skill.dirPath, SKILL_MAIN_FILE);
	const content = await readFile(skillMdPath, "utf8");
	const updated = setFrontmatterField(content, "disabled", disabled);
	await writeFile(skillMdPath, updated, "utf8");
}
