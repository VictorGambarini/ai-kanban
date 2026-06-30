import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseSkillsShSource, type RuntimeWorkspaceSkill } from "../core/api-contract";
import { ensureSkillGitExcludes } from "./skill-git-exclude";

const execFileAsync = promisify(execFile);

async function runSubprocess(binary: string, args: string[], options: { cwd: string }): Promise<string> {
	const { stdout } = await execFileAsync(binary, args, { cwd: options.cwd, env: process.env });
	return stdout;
}

const SKILL_MAIN_FILE = "SKILL.md";

// The `skills` CLI records the install source of every project skill in this lock file
// (keyed by skill name). It is the tool's own source of truth, written additively, so we
// read it for source grouping instead of re-deriving it ourselves. See docs/skills.md.
const SKILLS_LOCK_FILE = "skills-lock.json";

// Skill directories the `claude-code` and `cline` agents discover, matching what the
// `skills` CLI enumerates for a `list -p`/`-g`. Project dirs are resolved against the
// workspace; globals against the user's home. Project entries take precedence on name
// collisions (listed first).
const PROJECT_SKILL_DIRS = [
	[".agents", "skills"],
	[".claude", "skills"],
] as const;

function globalSkillDirs(): string[] {
	const home = homedir();
	return [join(home, ".claude", "skills"), join(home, ".config", "claude", "skills"), join(home, ".agents", "skills")];
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

function setFrontmatterField(content: string, field: string, value: unknown): string {
	const { frontmatter, body } = splitFrontmatter(content);
	frontmatter[field] = value;
	return serializeSkill(frontmatter, body);
}

// Mirrors the `skills` CLI's metadata sanitization: strip newlines and surrounding space
// so a multi-line description renders as a single clean line.
function sanitizeMetadata(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

interface ParsedSkill {
	name: string;
	description: string;
	disabled: boolean;
	installedFrom?: string;
	installedAt?: string;
}

// Parses a skill's SKILL.md the same way the CLI does: a skill must declare a non-empty
// `name` and `description`, and `metadata.internal` skills are hidden. `installedFrom`/
// `installedAt` are legacy Kanban-stamped fields kept as a fallback for source grouping.
function parseSkillMd(content: string): ParsedSkill | null {
	const { frontmatter } = splitFrontmatter(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
		return null;
	}
	const name = sanitizeMetadata(frontmatter.name);
	const description = sanitizeMetadata(frontmatter.description);
	if (!name || !description) {
		return null;
	}
	const metadata = frontmatter.metadata;
	if (metadata && typeof metadata === "object" && (metadata as Record<string, unknown>).internal === true) {
		return null;
	}
	const installedFrom = typeof frontmatter.installedFrom === "string" ? frontmatter.installedFrom.trim() : undefined;
	const installedAt = typeof frontmatter.installedAt === "string" ? frontmatter.installedAt.trim() : undefined;
	return {
		name,
		description,
		disabled: frontmatter.disabled === true,
		installedFrom: installedFrom || undefined,
		installedAt: installedAt || undefined,
	};
}

// Reads `skills-lock.json` and returns a map of skill name → normalized source slug
// (e.g. "garrytan/gstack"). Absent/unreadable lock → empty map.
async function readLockSources(workspacePath: string): Promise<Map<string, string>> {
	const sources = new Map<string, string>();
	let raw: string;
	try {
		raw = await readFile(join(workspacePath, SKILLS_LOCK_FILE), "utf8");
	} catch {
		return sources;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return sources;
	}
	const skills = (parsed as { skills?: unknown })?.skills;
	if (!skills || typeof skills !== "object") {
		return sources;
	}
	for (const [name, entry] of Object.entries(skills as Record<string, unknown>)) {
		const source = (entry as { source?: unknown })?.source;
		if (typeof source === "string" && source.trim()) {
			// Normalize through the same parser the install path uses so the group label
			// matches (e.g. a github URL collapses to "owner/repo").
			sources.set(name, parseSkillsShSource(source).repo);
		}
	}
	return sources;
}

async function listSkillDirsWithMain(root: string): Promise<Array<{ name: string; dirPath: string }>> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => ({ name: entry.name, dirPath: join(root, entry.name) }));
	} catch {
		return [];
	}
}

async function readSkillsFromDisk(workspacePath: string): Promise<RuntimeWorkspaceSkill[]> {
	const projectRoots = PROJECT_SKILL_DIRS.map((segments) => join(workspacePath, ...segments));
	const roots = [...projectRoots, ...globalSkillDirs()];

	const [lockSources, dirsPerRoot] = await Promise.all([
		readLockSources(workspacePath),
		Promise.all(roots.map((root) => listSkillDirsWithMain(root))),
	]);

	const byName = new Map<string, RuntimeWorkspaceSkill>();
	// Roots are ordered project-first, so the first occurrence of a name wins.
	const flatDirs = dirsPerRoot.flat();
	const parsed = await Promise.all(
		flatDirs.map(async (dir) => {
			try {
				const content = await readFile(join(dir.dirPath, SKILL_MAIN_FILE), "utf8");
				return { dir, skill: parseSkillMd(content) };
			} catch {
				return { dir, skill: null };
			}
		}),
	);

	for (const { dir, skill } of parsed) {
		if (!skill || byName.has(skill.name)) {
			continue;
		}
		byName.set(skill.name, {
			name: skill.name,
			description: skill.description,
			disabled: skill.disabled,
			dirPath: dir.dirPath,
			installedFrom: lockSources.get(skill.name) ?? skill.installedFrom,
			installedAt: skill.installedAt,
		});
	}
	return [...byName.values()];
}

// Short-lived cache so the per-task picker and Settings panel (which both list skills, and
// often mount together) don't each re-walk the skill directories. Every mutation below
// invalidates it, so the only staleness window is external edits within the TTL.
const SKILLS_CACHE_TTL_MS = 3_000;
const skillsCache = new Map<string, { skills: RuntimeWorkspaceSkill[]; expiresAt: number }>();

function invalidateSkillsCache(workspacePath: string): void {
	skillsCache.delete(workspacePath);
}

export async function listSkills(workspacePath: string): Promise<RuntimeWorkspaceSkill[]> {
	const cached = skillsCache.get(workspacePath);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.skills;
	}
	const skills = await readSkillsFromDisk(workspacePath);
	skillsCache.set(workspacePath, { skills, expiresAt: Date.now() + SKILLS_CACHE_TTL_MS });
	return skills;
}

export async function installSkill(workspacePath: string, source: string, skillNames?: string[]): Promise<void> {
	const { repo, skill } = parseSkillsShSource(source);
	// A skill named directly in the source URL acts as a default filter, but an explicit
	// skillNames argument from the caller takes precedence.
	const effectiveSkillNames = skillNames && skillNames.length > 0 ? skillNames : skill ? [skill] : [];

	const args = ["skills", "add", repo, "--agent", "claude-code", "--agent", "cline", "--copy", "--yes", "-p"];
	for (const name of effectiveSkillNames) {
		args.push("--skill", name);
	}
	await runSubprocess("npx", args, { cwd: workspacePath });

	invalidateSkillsCache(workspacePath);
	await stampInstallTimestamps(workspacePath, repo);
	invalidateSkillsCache(workspacePath);
	// Skills are installed into the project (.agents/.claude); keep them out of git diffs.
	await ensureSkillGitExcludes(workspacePath);
}

// Stamps an `installedAt` timestamp onto skills from `repo` that don't have one yet, so the
// UI's "NEW" badge has a per-skill install time. Source grouping comes from skills-lock.json
// (see listSkills), so this never touches `installedFrom` and cannot cross-contaminate the
// grouping of other sources' skills.
async function stampInstallTimestamps(workspacePath: string, repo: string): Promise<void> {
	const installedAt = new Date().toISOString();
	const skills = await listSkills(workspacePath);
	await Promise.all(
		skills
			.filter((s) => s.installedFrom === repo && !s.installedAt && s.dirPath)
			.map(async (s) => {
				try {
					const skillMdPath = join(s.dirPath, SKILL_MAIN_FILE);
					const content = await readFile(skillMdPath, "utf8");
					await writeFile(skillMdPath, setFrontmatterField(content, "installedAt", installedAt), "utf8");
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
	} finally {
		invalidateSkillsCache(workspacePath);
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
	invalidateSkillsCache(workspacePath);
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
	invalidateSkillsCache(workspacePath);
}
