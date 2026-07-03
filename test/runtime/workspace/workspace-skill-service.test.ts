import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// ── Mock the npx skills CLI (`skills add`, `skills remove`) ──
// Listing reads skill directories directly from disk (no CLI), so only the
// install/remove subprocess boundary is mocked. All filesystem work runs for real
// against a temp workspace so the SKILL.md and sidecar roundtrips are exercised.
const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

import { parseSkillsShSource } from "../../../src/core/api-contract";
import {
	createSkill,
	installSkill,
	listSkills,
	removeSkill,
	setSkillDisabled,
} from "../../../src/workspace/workspace-skill-service";

let workspace: string;
let fakeHome: string;
let originalHome: string | undefined;

// Parse the YAML frontmatter block of a SKILL.md into an object.
function frontmatterOf(markdown: string): Record<string, unknown> {
	const match = markdown.match(/^---\n([\s\S]*?)\n---/);
	expect(match).not.toBeNull();
	const block = match?.[1] ?? "";
	return parseYaml(block) as Record<string, unknown>;
}

// Find the recorded CLI invocation whose second arg matches the given subcommand.
function findCliCall(subcommand: string): string[] {
	const call = childProcessMocks.execFilePromise.mock.calls.find((c) => c[1]?.[1] === subcommand);
	expect(call, `expected a "skills ${subcommand}" CLI invocation`).toBeDefined();
	return (call?.[1] ?? []) as string[];
}

// Write a SKILL.md directly to a skills directory (default: the project's .agents/skills).
async function writeSkillAt(
	root: string,
	name: string,
	{ description = "d", body = "body", extraFrontmatter = [] as string[] } = {},
): Promise<string> {
	const skillDir = join(root, name);
	await mkdir(skillDir, { recursive: true });
	const lines = ["---", `name: ${name}`, `description: ${description}`, ...extraFrontmatter, "---", "", body];
	await writeFile(join(skillDir, "SKILL.md"), `${lines.join("\n")}\n`, "utf8");
	return skillDir;
}

async function writeSkill(
	name: string,
	{
		description = "d",
		dir = ".agents/skills",
		body = "body",
		extraFrontmatter = [] as string[],
	}: { description?: string; dir?: string; body?: string; extraFrontmatter?: string[] } = {},
): Promise<string> {
	return await writeSkillAt(join(workspace, dir), name, { description, body, extraFrontmatter });
}

async function writeGlobalSkill(name: string, { description = "g" } = {}): Promise<string> {
	return await writeSkillAt(join(fakeHome, ".claude", "skills"), name, { description });
}

// Write a skills-lock.json mapping skill names to their install source.
async function writeLock(skills: Record<string, string>): Promise<void> {
	const entries = Object.fromEntries(Object.entries(skills).map(([name, source]) => [name, { source }]));
	await writeFile(
		join(workspace, "skills-lock.json"),
		JSON.stringify({ version: 1, skills: entries }, null, 2),
		"utf8",
	);
}

async function readMeta(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(workspace, ".agents", "skills-meta.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), "skill-svc-test-"));
	// Point HOME at an empty temp dir so the global skill scan is hermetic.
	fakeHome = await mkdtemp(join(tmpdir(), "skill-svc-home-"));
	originalHome = process.env.HOME;
	process.env.HOME = fakeHome;
	childProcessMocks.execFilePromise.mockReset();
	childProcessMocks.execFilePromise.mockResolvedValue({ stdout: "" });
});

afterEach(async () => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	await rm(workspace, { recursive: true, force: true });
	await rm(fakeHome, { recursive: true, force: true });
});

describe("createSkill", () => {
	it("writes a slugified SKILL.md with valid YAML frontmatter and body", async () => {
		await createSkill(workspace, {
			name: "My Cool Skill",
			description: 'Handles "quoted" text & symbols',
			instructions: "# Heading\n\nDo the thing.\nLine two with `code`.",
		});

		const md = await readFile(join(workspace, ".agents/skills/my-cool-skill/SKILL.md"), "utf8");
		expect(md.startsWith("---\n")).toBe(true);

		// Frontmatter must be parseable YAML with the round-tripped values intact.
		const fm = frontmatterOf(md);
		expect(fm.name).toBe("my-cool-skill");
		expect(fm.description).toBe('Handles "quoted" text & symbols');

		expect(md).toContain("Do the thing.");
		expect(md).toContain("Line two with `code`.");
	});

	it("omits description when not provided", async () => {
		await createSkill(workspace, { name: "bare", instructions: "body only" });
		const md = await readFile(join(workspace, ".agents/skills/bare/SKILL.md"), "utf8");
		const fm = frontmatterOf(md);
		expect(fm.name).toBe("bare");
		expect(fm.description).toBeUndefined();
	});
});

describe("listSkills (disk-based, scope-aware)", () => {
	it("reads name, description, and disabled flag from each skill's SKILL.md", async () => {
		const alphaDir = await writeSkill("alpha", { description: "Alpha desc" });

		const skills = await listSkills(workspace);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "alpha",
			description: "Alpha desc",
			disabled: false,
			dirPath: alphaDir,
			scope: "project",
		});
	});

	it("ignores directories whose SKILL.md lacks a name or description", async () => {
		await writeSkillAt(join(workspace, ".agents/skills"), "nameless-ok", { description: "has desc" });
		// Missing description → not a listable skill.
		const dir = join(workspace, ".agents/skills/no-desc");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "SKILL.md"), "---\nname: no-desc\n---\n\nbody\n", "utf8");

		const skills = await listSkills(workspace);
		expect(skills.map((s) => s.name)).toEqual(["nameless-ok"]);
	});

	it("skips dot-directories (e.g. version backups) in skill roots", async () => {
		await writeSkill("real", { description: "r" });
		await writeSkill(".real-1.0.0.bak", { description: "backup copy" });

		const skills = await listSkills(workspace);
		expect(skills.map((s) => s.name)).toEqual(["real"]);
	});

	it("deduplicates a skill present in both .agents/skills and .claude/skills, preferring .agents", async () => {
		const agentsDir = await writeSkill("dup", { dir: ".agents/skills" });
		await writeSkill("dup", { dir: ".claude/skills" });

		const skills = await listSkills(workspace);
		const dups = skills.filter((s) => s.name === "dup");
		expect(dups).toHaveLength(1);
		expect(dups[0].dirPath).toBe(agentsDir);
	});

	it("lists global skills with scope 'global'", async () => {
		const globalDir = await writeGlobalSkill("worldwide");

		const skills = await listSkills(workspace);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ name: "worldwide", scope: "global", dirPath: globalDir });
	});

	it("lists both copies when a project skill and a global skill share a name", async () => {
		const projectDir = await writeSkill("qa", { description: "project qa" });
		const globalDir = await writeGlobalSkill("qa", { description: "global qa" });

		const skills = await listSkills(workspace);
		const qa = skills.filter((s) => s.name === "qa");
		expect(qa).toHaveLength(2);
		expect(qa.find((s) => s.scope === "project")?.dirPath).toBe(projectDir);
		expect(qa.find((s) => s.scope === "global")?.dirPath).toBe(globalDir);
		// Project scope is listed first so name-based consumers resolve project-first.
		expect(skills.findIndex((s) => s.scope === "project")).toBeLessThan(
			skills.findIndex((s) => s.scope === "global"),
		);
	});

	it("groups by the source recorded in skills-lock.json", async () => {
		await writeSkill("gstack-skill");
		await writeSkill("qa-skill");
		await writeLock({ "gstack-skill": "garrytan/gstack", "qa-skill": "mattpocock/skills" });

		const skills = await listSkills(workspace);
		const byName = new Map(skills.map((s) => [s.name, s]));
		expect(byName.get("gstack-skill")?.installedFrom).toBe("garrytan/gstack");
		expect(byName.get("qa-skill")?.installedFrom).toBe("mattpocock/skills");
	});

	it("normalizes a lock source URL to an owner/repo slug", async () => {
		await writeSkill("url-skill");
		await writeLock({ "url-skill": "https://github.com/anthropics/skills.git" });

		const skills = await listSkills(workspace);
		expect(skills[0].installedFrom).toBe("anthropics/skills");
	});

	it("falls back to a legacy installedFrom frontmatter field when no lock entry exists", async () => {
		await writeSkill("legacy", { extraFrontmatter: ["installedFrom: old/source"] });

		const skills = await listSkills(workspace);
		expect(skills[0].installedFrom).toBe("old/source");
	});

	it("backfills lock attribution into the sidecar so grouping survives lock deletion", async () => {
		await writeSkill("durable");
		await writeLock({ durable: "some/source" });

		// First list migrates the attribution into .agents/skills-meta.json…
		await listSkills(workspace);
		const meta = await readMeta();
		expect((meta.project as Record<string, { installedFrom?: string }>).durable?.installedFrom).toBe("some/source");

		// …so deleting the lock (untracked + git-excluded, it happens) loses nothing.
		await rm(join(workspace, "skills-lock.json"));
		await writeSkill("cache-buster"); // invalidate the in-memory list cache
		await removeSkill(workspace, "cache-buster");
		const skills = await listSkills(workspace);
		expect(skills.find((s) => s.name === "durable")?.installedFrom).toBe("some/source");
	});
});

describe("setSkillDisabled", () => {
	it("stores the disabled flag in the sidecar without touching SKILL.md", async () => {
		const dir = await writeSkill("toggle", { description: "keep me", body: "# Keep\nbody text" });
		const originalMd = await readFile(join(dir, "SKILL.md"), "utf8");

		await setSkillDisabled(workspace, "toggle", true);
		// SKILL.md is byte-identical: frontmatter writes broke the CLI's computedHash.
		expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(originalMd);
		let skills = await listSkills(workspace);
		expect(skills.find((s) => s.name === "toggle")?.disabled).toBe(true);

		await setSkillDisabled(workspace, "toggle", false);
		expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(originalMd);
		skills = await listSkills(workspace);
		expect(skills.find((s) => s.name === "toggle")?.disabled).toBe(false);
	});

	it("still honors a legacy frontmatter disabled flag as the default", async () => {
		await writeSkill("legacy-off", { extraFrontmatter: ["disabled: true"] });
		const skills = await listSkills(workspace);
		expect(skills[0].disabled).toBe(true);
	});

	it("disables a global skill per-workspace without writing to the global directory", async () => {
		const globalDir = await writeGlobalSkill("shared");
		const originalMd = await readFile(join(globalDir, "SKILL.md"), "utf8");

		await setSkillDisabled(workspace, "shared", true, "global");

		expect(await readFile(join(globalDir, "SKILL.md"), "utf8")).toBe(originalMd);
		const skills = await listSkills(workspace);
		expect(skills.find((s) => s.name === "shared")?.disabled).toBe(true);
		const meta = await readMeta();
		expect((meta.global as Record<string, { disabled?: boolean }>).shared?.disabled).toBe(true);
	});

	it("targets the scope's own entry when a project and global skill share a name", async () => {
		await writeSkill("qa");
		await writeGlobalSkill("qa");

		await setSkillDisabled(workspace, "qa", true, "global");

		const skills = await listSkills(workspace);
		expect(skills.find((s) => s.name === "qa" && s.scope === "project")?.disabled).toBe(false);
		expect(skills.find((s) => s.name === "qa" && s.scope === "global")?.disabled).toBe(true);
	});

	it("throws when the skill does not exist", async () => {
		await expect(setSkillDisabled(workspace, "ghost", true)).rejects.toThrow(/not found/);
	});
});

describe("installSkill", () => {
	it("invokes the skills CLI with project scope and both agents", async () => {
		await installSkill(workspace, "owner/repo@thing");
		const args = findCliCall("add");
		expect(args).toEqual(
			expect.arrayContaining([
				"skills",
				"add",
				"owner/repo@thing",
				"--agent",
				"claude-code",
				"--agent",
				"cline",
				"--copy",
				"--yes",
				"-p",
			]),
		);
	});

	it("passes --skill filters when specific skills are requested", async () => {
		await installSkill(workspace, "owner/repo", ["one", "two"]);
		const args = findCliCall("add");
		expect(args).toEqual(expect.arrayContaining(["--skill", "one", "--skill", "two"]));
	});

	it("normalizes a skills.sh URL to owner/repo and filters to the named skill", async () => {
		await installSkill(workspace, "https://www.skills.sh/anthropics/skills/frontend-design");
		const args = findCliCall("add");
		expect(args).toContain("anthropics/skills");
		expect(args).not.toContain("https://www.skills.sh/anthropics/skills/frontend-design");
		expect(args).toEqual(expect.arrayContaining(["--skill", "frontend-design"]));
	});

	it("reports the skills the install actually added, diffed from disk", async () => {
		await writeSkill("pre-existing");
		// Simulate the CLI's effect: new skill files appear when `add` runs.
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[1] === "add") {
				await writeSkill("brand-new", { description: "fresh" });
				await writeLock({ "brand-new": "anthropics/skills" });
			}
			return { stdout: "" };
		});

		const result = await installSkill(workspace, "anthropics/skills");
		expect(result.installedNames).toEqual(["brand-new"]);
	});

	it("returns no installed names when the CLI adds nothing", async () => {
		await writeSkill("already-here");
		const result = await installSkill(workspace, "anthropics/skills");
		expect(result.installedNames).toEqual([]);
	});

	it("stamps durable attribution and installedAt into the sidecar (not SKILL.md)", async () => {
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[1] === "add") {
				await writeSkill("frontend-design", { description: "fd" });
			}
			return { stdout: "" };
		});

		await installSkill(workspace, "anthropics/skills", ["frontend-design"]);

		// SKILL.md keeps only what the source shipped — no Kanban-stamped fields.
		const fm = frontmatterOf(await readFile(join(workspace, ".agents/skills/frontend-design/SKILL.md"), "utf8"));
		expect(fm.installedFrom).toBeUndefined();
		expect(fm.installedAt).toBeUndefined();

		// Attribution + timestamp live in the sidecar and flow into the listing even
		// though no skills-lock.json exists.
		const skills = await listSkills(workspace);
		const skill = skills.find((s) => s.name === "frontend-design");
		expect(skill?.installedFrom).toBe("anthropics/skills");
		expect(typeof skill?.installedAt).toBe("string");
		expect(Number.isNaN(Date.parse(skill?.installedAt ?? ""))).toBe(false);
	});

	it("does not refresh installedAt for skills that were already present", async () => {
		await writeSkill("stable");
		await writeLock({ stable: "anthropics/skills" });
		await listSkills(workspace); // backfill installedFrom into the sidecar

		await installSkill(workspace, "anthropics/skills");

		const meta = await readMeta();
		expect((meta.project as Record<string, { installedAt?: string }>).stable?.installedAt).toBeUndefined();
	});

	it("warns when an installed skill is shadowing a global skill of the same name", async () => {
		await writeGlobalSkill("qa");
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[1] === "add") {
				await writeSkill("qa", { description: "project qa" });
			}
			return { stdout: "" };
		});

		const result = await installSkill(workspace, "mattpocock/skills");
		expect(result.installedNames).toEqual(["qa"]);
		expect(result.warnings.some((w) => w.includes("global"))).toBe(true);
	});

	it("warns when an install overwrites a same-named skill from another source", async () => {
		await writeSkill("qa");
		await writeLock({ qa: "mattpocock/skills" });
		await listSkills(workspace); // seed sidecar attribution for the original source
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[1] === "add") {
				await writeLock({ qa: "garrytan/gstack" });
			}
			return { stdout: "" };
		});

		const result = await installSkill(workspace, "garrytan/gstack");
		expect(result.installedNames).toEqual(["qa"]);
		expect(result.warnings.some((w) => w.includes("mattpocock/skills"))).toBe(true);
		// Attribution moves to the new source.
		const skills = await listSkills(workspace);
		expect(skills.find((s) => s.name === "qa")?.installedFrom).toBe("garrytan/gstack");
	});

	it("surfaces the CLI's 'no matching skills' output as a readable error", async () => {
		const cliError = Object.assign(new Error("Command failed: npx skills add"), {
			stdout: "│\n■  No matching skills found for: qa\n│\n●  Available skills:\n│\n│    - gstack\n",
			stderr: "",
		});
		childProcessMocks.execFilePromise.mockRejectedValue(cliError);

		await expect(installSkill(workspace, "garrytan/gstack", ["qa"])).rejects.toThrow(
			/No matching skills found for: qa.*Available skills: gstack/s,
		);
	});
});

describe("parseSkillsShSource", () => {
	it("extracts owner/repo and skill from a skills.sh URL", () => {
		expect(parseSkillsShSource("https://www.skills.sh/anthropics/skills/frontend-design")).toEqual({
			repo: "anthropics/skills",
			skill: "frontend-design",
		});
	});

	it("handles a skills.sh URL without a specific skill", () => {
		expect(parseSkillsShSource("https://skills.sh/anthropics/skills")).toEqual({ repo: "anthropics/skills" });
	});

	it("passes through a bare owner/repo slug", () => {
		expect(parseSkillsShSource("owner/repo")).toEqual({ repo: "owner/repo" });
	});

	it("normalizes a GitHub URL and tolerates a trailing slash / .git", () => {
		expect(parseSkillsShSource("https://github.com/anthropics/skills.git/")).toEqual({
			repo: "anthropics/skills",
		});
	});
});

describe("removeSkill", () => {
	it("calls the CLI remove command at project scope", async () => {
		await writeSkill("gone");
		await removeSkill(workspace, "gone");
		const args = findCliCall("remove");
		expect(args).toEqual(expect.arrayContaining(["skills", "remove", "gone", "--yes", "-p"]));
	});

	it("removes both project copies even when the CLI silently removes nothing", async () => {
		// The real CLI exits 0 with "No skills found to remove" in this situation.
		const agentsDir = await writeSkill("zombie", { dir: ".agents/skills" });
		const claudeDir = await writeSkill("zombie", { dir: ".claude/skills" });

		await removeSkill(workspace, "zombie");

		await expect(stat(agentsDir)).rejects.toThrow();
		await expect(stat(claudeDir)).rejects.toThrow();
		expect(await listSkills(workspace)).toHaveLength(0);
	});

	it("falls back to direct directory removal when the CLI errors", async () => {
		const dir = await writeSkill("manual");
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[1] === "remove") {
				throw new Error("not found at project scope");
			}
			return { stdout: "" };
		});

		await removeSkill(workspace, "manual");
		await expect(readFile(join(dir, "SKILL.md"), "utf8")).rejects.toThrow();
	});

	it("cleans up the skill's lock and sidecar entries", async () => {
		await writeSkill("tracked");
		await writeLock({ tracked: "some/source", other: "other/source" });
		await listSkills(workspace); // seed the sidecar via backfill

		await removeSkill(workspace, "tracked");

		const lock = JSON.parse(await readFile(join(workspace, "skills-lock.json"), "utf8")) as {
			skills: Record<string, unknown>;
		};
		expect(lock.skills.tracked).toBeUndefined();
		expect(lock.skills.other).toBeDefined();
		const meta = await readMeta();
		expect((meta.project as Record<string, unknown>).tracked).toBeUndefined();
	});

	it("refuses to delete a global skill and leaves it on disk", async () => {
		const globalDir = await writeGlobalSkill("untouchable");

		await expect(removeSkill(workspace, "untouchable")).rejects.toThrow(/globally/);
		await expect(stat(globalDir)).resolves.toBeDefined();
		// The CLI must not be invoked for a refused global removal.
		expect(childProcessMocks.execFilePromise.mock.calls.some((c) => c[1]?.[1] === "remove")).toBe(false);
	});

	it("removes the project copy but leaves a same-named global skill alone", async () => {
		const projectDir = await writeSkill("qa");
		const globalDir = await writeGlobalSkill("qa");

		await removeSkill(workspace, "qa");

		await expect(stat(projectDir)).rejects.toThrow();
		await expect(stat(globalDir)).resolves.toBeDefined();
		const skills = await listSkills(workspace);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ name: "qa", scope: "global" });
	});
});
