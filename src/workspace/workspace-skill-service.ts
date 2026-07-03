import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseSkillsShSource, type RuntimeWorkspaceSkill, type RuntimeWorkspaceSkillScope } from "../core/api-contract";
import { ensureSkillGitExcludes } from "./skill-git-exclude";

const execFileAsync = promisify(execFile);

async function runSubprocess(binary: string, args: string[], options: { cwd: string }): Promise<string> {
	const { stdout } = await execFileAsync(binary, args, { cwd: options.cwd, env: process.env });
	return stdout;
}

const SKILL_MAIN_FILE = "SKILL.md";

// The `skills` CLI records the install source of every project skill in this lock file
// (keyed by skill name). It is written additively and can be deleted at any time (it is
// untracked and git-excluded), so it is treated as enrichment only — Kanban's own durable
// record is the sidecar below. See docs/skills.md.
const SKILLS_LOCK_FILE = "skills-lock.json";

// Kanban's own durable, git-excluded metadata sidecar. Holds everything Kanban used to
// stamp into SKILL.md frontmatter (installedFrom/installedAt) plus disabled overrides.
// Writing SKILL.md is avoided entirely: it broke the skills CLI's computedHash integrity
// record, and stamping only landed on one of the two installed copies.
const SKILLS_META_DIR = ".agents";
const SKILLS_META_FILE = "skills-meta.json";

interface SkillMetaEntry {
	installedFrom?: string;
	installedAt?: string;
	disabled?: boolean;
}

interface SkillsMeta {
	version: 1;
	/** Metadata for project-scoped skills, keyed by skill name. */
	project: Record<string, SkillMetaEntry>;
	/** Per-workspace overrides for global skills (disabled only), keyed by skill name. */
	global: Record<string, SkillMetaEntry>;
}

function emptySkillsMeta(): SkillsMeta {
	return { version: 1, project: {}, global: {} };
}

function skillsMetaPath(workspacePath: string): string {
	return join(workspacePath, SKILLS_META_DIR, SKILLS_META_FILE);
}

async function readSkillsMeta(workspacePath: string): Promise<SkillsMeta> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(skillsMetaPath(workspacePath), "utf8"));
	} catch {
		return emptySkillsMeta();
	}
	if (!parsed || typeof parsed !== "object") {
		return emptySkillsMeta();
	}
	const raw = parsed as { project?: unknown; global?: unknown };
	const readScope = (value: unknown): Record<string, SkillMetaEntry> => {
		if (!value || typeof value !== "object") {
			return {};
		}
		const entries: Record<string, SkillMetaEntry> = {};
		for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			const { installedFrom, installedAt, disabled } = entry as Record<string, unknown>;
			entries[name] = {
				...(typeof installedFrom === "string" && installedFrom ? { installedFrom } : {}),
				...(typeof installedAt === "string" && installedAt ? { installedAt } : {}),
				...(typeof disabled === "boolean" ? { disabled } : {}),
			};
		}
		return entries;
	};
	return { version: 1, project: readScope(raw.project), global: readScope(raw.global) };
}

async function writeSkillsMeta(workspacePath: string, meta: SkillsMeta): Promise<void> {
	await mkdir(join(workspacePath, SKILLS_META_DIR), { recursive: true });
	await writeFile(skillsMetaPath(workspacePath), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

async function updateSkillsMeta(workspacePath: string, mutate: (meta: SkillsMeta) => void): Promise<void> {
	const meta = await readSkillsMeta(workspacePath);
	mutate(meta);
	await writeSkillsMeta(workspacePath, meta);
}

// Skill directories the `claude-code` and `cline` agents discover, matching what the
// `skills` CLI enumerates for a `list -p`/`-g`. Project dirs are resolved against the
// workspace; globals against the user's home. Within a scope, earlier roots win name
// collisions; across scopes both entries are listed (see readSkillsFromDisk).
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
// `installedAt` are legacy Kanban-stamped fields kept as a read-only fallback; the
// sidecar (skills-meta.json) is the durable source now.
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

// Removes a skill's entry from skills-lock.json so removed skills don't leave stale
// attribution behind. Best-effort: a missing/unreadable lock is left alone.
async function removeLockEntry(workspacePath: string, name: string): Promise<void> {
	const lockPath = join(workspacePath, SKILLS_LOCK_FILE);
	let parsed: { skills?: Record<string, unknown> };
	try {
		parsed = JSON.parse(await readFile(lockPath, "utf8")) as { skills?: Record<string, unknown> };
	} catch {
		return;
	}
	if (!parsed?.skills || typeof parsed.skills !== "object" || !(name in parsed.skills)) {
		return;
	}
	delete parsed.skills[name];
	try {
		await writeFile(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
	} catch {
		// Best-effort cleanup; a stale lock entry is harmless.
	}
}

async function listSkillDirsWithMain(root: string): Promise<Array<{ name: string; dirPath: string }>> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return (
			entries
				// Dot-directories are never skills (e.g. gstack's `.gstack-<version>.bak` backups).
				.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
				.map((entry) => ({ name: entry.name, dirPath: join(root, entry.name) }))
		);
	} catch {
		return [];
	}
}

async function parseSkillsInRoots(roots: string[]): Promise<Array<{ dirPath: string; skill: ParsedSkill }>> {
	const dirsPerRoot = await Promise.all(roots.map((root) => listSkillDirsWithMain(root)));
	const flatDirs = dirsPerRoot.flat();
	const parsed = await Promise.all(
		flatDirs.map(async (dir) => {
			try {
				const content = await readFile(join(dir.dirPath, SKILL_MAIN_FILE), "utf8");
				return { dirPath: dir.dirPath, skill: parseSkillMd(content) };
			} catch {
				return { dirPath: dir.dirPath, skill: null };
			}
		}),
	);
	return parsed.filter((entry): entry is { dirPath: string; skill: ParsedSkill } => entry.skill !== null);
}

async function readSkillsFromDisk(workspacePath: string): Promise<RuntimeWorkspaceSkill[]> {
	const projectRoots = PROJECT_SKILL_DIRS.map((segments) => join(workspacePath, ...segments));

	const [meta, lockSources, projectParsed, globalParsed] = await Promise.all([
		readSkillsMeta(workspacePath),
		readLockSources(workspacePath),
		parseSkillsInRoots(projectRoots),
		parseSkillsInRoots(globalSkillDirs()),
	]);

	// Project scope: roots are ordered .agents-first, so the first occurrence of a name
	// wins (the CLI installs identical copies into both roots).
	const project = new Map<string, RuntimeWorkspaceSkill>();
	const metaBackfill: Record<string, SkillMetaEntry> = {};
	for (const { dirPath, skill } of projectParsed) {
		if (project.has(skill.name)) {
			continue;
		}
		const entry = meta.project[skill.name];
		const installedFrom = entry?.installedFrom ?? lockSources.get(skill.name) ?? skill.installedFrom;
		const installedAt = entry?.installedAt ?? skill.installedAt;
		project.set(skill.name, {
			name: skill.name,
			description: skill.description,
			disabled: entry?.disabled ?? skill.disabled,
			dirPath,
			scope: "project",
			installedFrom,
			installedAt,
		});
		// Migration: persist lock/legacy-frontmatter attribution into the sidecar so it
		// survives the lock file being deleted (untracked + git-excluded, it often is).
		const needsFrom = installedFrom !== undefined && entry?.installedFrom === undefined;
		const needsAt = installedAt !== undefined && entry?.installedAt === undefined;
		if (needsFrom || needsAt) {
			metaBackfill[skill.name] = {
				...entry,
				...(needsFrom ? { installedFrom } : {}),
				...(needsAt ? { installedAt } : {}),
			};
		}
	}
	if (Object.keys(metaBackfill).length > 0) {
		await updateSkillsMeta(workspacePath, (m) => {
			for (const [name, entry] of Object.entries(metaBackfill)) {
				m.project[name] = { ...m.project[name], ...entry };
			}
		}).catch(() => {
			// Best-effort persistence; listing must not fail because the backfill did.
		});
	}

	// Global scope: never shadowed by project skills — both are listed, each with its
	// scope, and consumers resolve name collisions project-first.
	const global = new Map<string, RuntimeWorkspaceSkill>();
	for (const { dirPath, skill } of globalParsed) {
		if (global.has(skill.name)) {
			continue;
		}
		const entry = meta.global[skill.name];
		global.set(skill.name, {
			name: skill.name,
			description: skill.description,
			disabled: entry?.disabled ?? skill.disabled,
			dirPath,
			scope: "global",
			installedFrom: skill.installedFrom,
			installedAt: skill.installedAt,
		});
	}

	return [...project.values(), ...global.values()];
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

// Finds the skill a name refers to, preferring the project copy when both scopes have
// one (mirrors how injection resolves collisions).
function findSkill(
	skills: RuntimeWorkspaceSkill[],
	name: string,
	scope?: RuntimeWorkspaceSkillScope,
): RuntimeWorkspaceSkill | undefined {
	if (scope) {
		return skills.find((s) => s.name === name && s.scope === scope);
	}
	return skills.find((s) => s.name === name && s.scope === "project") ?? skills.find((s) => s.name === name);
}

const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}?\\[[0-9;?]*[A-Za-z]`, "g");

// Turns the skills CLI's spinner-and-box-drawing output into a short human-readable
// message, surfacing known failure lines (e.g. "No matching skills found for: qa" plus
// the available skill names) instead of a raw exec error.
function formatSkillsCliError(error: unknown, fallback: string): Error {
	const raw = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
	const combined = `${typeof raw.stdout === "string" ? raw.stdout : ""}\n${typeof raw.stderr === "string" ? raw.stderr : ""}`;
	const lines = combined
		.replace(ANSI_ESCAPE_REGEX, "")
		.split(/\r?\n|\r/)
		.map((line) => line.replace(/^[\s│┌├└◇◆■●○◒◐◓◑╮╯╭─]+/u, "").trim())
		.filter(Boolean);
	const noMatchIndex = lines.findIndex((line) => line.startsWith("No matching skills found"));
	if (noMatchIndex !== -1) {
		const available = lines
			.slice(noMatchIndex + 1)
			.filter((line) => line.startsWith("- "))
			.map((line) => line.slice(2).trim());
		const suffix = available.length > 0 ? ` Available skills: ${available.join(", ")}.` : "";
		return new Error(`${lines[noMatchIndex]}.${suffix}`);
	}
	const errorLine = lines.find((line) => /error|failed|not found|cannot|unable/i.test(line));
	if (errorLine) {
		return new Error(errorLine);
	}
	const tail = lines.slice(-2).join(" — ");
	const message = typeof raw.message === "string" && !tail ? raw.message : tail;
	return new Error(message || fallback);
}

export interface SkillInstallResult {
	/** Project skills this install added or re-attributed to the requested source. */
	installedNames: string[];
	/** Non-fatal issues worth surfacing (overwrites, global-shadowing collisions). */
	warnings: string[];
}

export async function installSkill(
	workspacePath: string,
	source: string,
	skillNames?: string[],
): Promise<SkillInstallResult> {
	const { repo, skill } = parseSkillsShSource(source);
	// A skill named directly in the source URL acts as a default filter, but an explicit
	// skillNames argument from the caller takes precedence.
	const effectiveSkillNames = skillNames && skillNames.length > 0 ? skillNames : skill ? [skill] : [];

	// Snapshot the pre-install state so the result reports what actually changed —
	// the CLI's exit code alone says nothing about what was installed.
	const before = await readSkillsFromDisk(workspacePath);
	const beforeProject = new Map(before.filter((s) => s.scope === "project").map((s) => [s.name, s]));
	const globalNames = new Set(before.filter((s) => s.scope === "global").map((s) => s.name));

	const args = ["skills", "add", repo, "--agent", "claude-code", "--agent", "cline", "--copy", "--yes", "-p"];
	for (const name of effectiveSkillNames) {
		args.push("--skill", name);
	}
	try {
		await runSubprocess("npx", args, { cwd: workspacePath });
	} catch (error) {
		throw formatSkillsCliError(error, `Failed to install from ${repo}`);
	}

	invalidateSkillsCache(workspacePath);
	const after = await readSkillsFromDisk(workspacePath);
	const lockSources = await readLockSources(workspacePath);

	const installedNames: string[] = [];
	const warnings: string[] = [];
	for (const skillEntry of after) {
		if (skillEntry.scope !== "project") {
			continue;
		}
		const previous = beforeProject.get(skillEntry.name);
		const attributedHere = lockSources.get(skillEntry.name) === repo;
		if (!previous) {
			installedNames.push(skillEntry.name);
		} else if (attributedHere && previous.installedFrom && previous.installedFrom !== repo) {
			// Same-named skill overwritten in place by a different source.
			installedNames.push(skillEntry.name);
			warnings.push(`Replaced "${skillEntry.name}" (previously installed from ${previous.installedFrom}).`);
		}
	}
	for (const name of installedNames) {
		if (globalNames.has(name)) {
			warnings.push(`"${name}" also exists as a global skill; the project copy takes precedence.`);
		}
	}

	// Record durable attribution + install time for the NEW badge and source grouping.
	if (installedNames.length > 0) {
		const installedAt = new Date().toISOString();
		await updateSkillsMeta(workspacePath, (meta) => {
			for (const name of installedNames) {
				meta.project[name] = { ...meta.project[name], installedFrom: repo, installedAt };
			}
		});
	}

	invalidateSkillsCache(workspacePath);
	// Skills are installed into the project (.agents/.claude); keep them out of git diffs.
	await ensureSkillGitExcludes(workspacePath);
	return { installedNames, warnings };
}

export async function removeSkill(
	workspacePath: string,
	name: string,
	scope?: RuntimeWorkspaceSkillScope,
): Promise<void> {
	invalidateSkillsCache(workspacePath);
	const skills = await readSkillsFromDisk(workspacePath);
	const target = findSkill(skills, name, scope);
	if (target?.scope === "global") {
		throw new Error(
			`"${name}" is installed globally (${target.dirPath}). Kanban only removes project skills — ` +
				`remove it with the skills CLI or delete the directory manually.`,
		);
	}

	if (target) {
		try {
			await runSubprocess("npx", ["skills", "remove", name, "--yes", "-p"], { cwd: workspacePath });
		} catch {
			// The CLI errors for skills it didn't install (e.g. locally created ones);
			// the direct removal below covers those.
		}
	}

	// Post-verify: the CLI exits 0 even when it removed nothing, so never trust it.
	// Delete every project copy of the skill (by frontmatter name and directory name).
	const dirNames = new Set<string>([name]);
	if (target?.dirPath) {
		dirNames.add(basename(target.dirPath));
	}
	for (const segments of PROJECT_SKILL_DIRS) {
		for (const dirName of dirNames) {
			await rm(join(workspacePath, ...segments, dirName), { recursive: true, force: true });
		}
	}

	await removeLockEntry(workspacePath, name);
	await updateSkillsMeta(workspacePath, (meta) => {
		delete meta.project[name];
	});
	invalidateSkillsCache(workspacePath);
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

export async function setSkillDisabled(
	workspacePath: string,
	name: string,
	disabled: boolean,
	scope?: RuntimeWorkspaceSkillScope,
): Promise<void> {
	const skills = await listSkills(workspacePath);
	const target = findSkill(skills, name, scope);
	if (!target) {
		throw new Error(`Skill "${name}" not found`);
	}
	// Stored in the sidecar, never in SKILL.md: frontmatter writes broke the skills CLI's
	// computedHash, and for global skills they would leak into every other project.
	await updateSkillsMeta(workspacePath, (meta) => {
		const scopeEntries = target.scope === "global" ? meta.global : meta.project;
		scopeEntries[name] = { ...scopeEntries[name], disabled };
	});
	invalidateSkillsCache(workspacePath);
}
