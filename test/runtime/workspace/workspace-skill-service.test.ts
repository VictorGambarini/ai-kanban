import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// ── Mock the npx skills CLI (`skills add`, `skills remove`) ──
// Listing now reads skill directories directly from disk (no CLI), so only the
// install/remove subprocess boundary is mocked. All filesystem work runs for real
// against a temp workspace so the SKILL.md read/write roundtrip is exercised.
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

// Write a SKILL.md directly to a project skills directory (default: .agents/skills).
async function writeSkill(
	name: string,
	{ description, dir = ".agents/skills", body = "body" }: { description?: string; dir?: string; body?: string } = {},
): Promise<string> {
	const skillDir = join(workspace, dir, name);
	await mkdir(skillDir, { recursive: true });
	const lines = ["---", `name: ${name}`];
	if (description !== undefined) {
		lines.push(`description: ${description}`);
	}
	lines.push("---", "", body);
	await writeFile(join(skillDir, "SKILL.md"), `${lines.join("\n")}\n`, "utf8");
	return skillDir;
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

describe("listSkills (disk-based)", () => {
	it("reads name, description, and disabled flag from each skill's SKILL.md", async () => {
		const alphaDir = await writeSkill("alpha", { description: "Alpha desc" });

		const skills = await listSkills(workspace);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "alpha",
			description: "Alpha desc",
			disabled: false,
			dirPath: alphaDir,
		});
	});

	it("ignores directories whose SKILL.md lacks a name or description", async () => {
		await writeSkill("nameless-ok", { description: "has desc" });
		await writeSkill("no-desc"); // missing description → not a listable skill

		const skills = await listSkills(workspace);
		expect(skills.map((s) => s.name)).toEqual(["nameless-ok"]);
	});

	it("deduplicates a skill present in both .agents/skills and .claude/skills, preferring .agents", async () => {
		const agentsDir = await writeSkill("dup", { description: "d", dir: ".agents/skills" });
		await writeSkill("dup", { description: "d", dir: ".claude/skills" });

		const skills = await listSkills(workspace);
		const dups = skills.filter((s) => s.name === "dup");
		expect(dups).toHaveLength(1);
		expect(dups[0].dirPath).toBe(agentsDir);
	});

	it("groups by the source recorded in skills-lock.json", async () => {
		await writeSkill("gstack-skill", { description: "g" });
		await writeSkill("qa-skill", { description: "q" });
		await writeLock({ "gstack-skill": "garrytan/gstack", "qa-skill": "mattpocock/skills" });

		const skills = await listSkills(workspace);
		const byName = new Map(skills.map((s) => [s.name, s]));
		expect(byName.get("gstack-skill")?.installedFrom).toBe("garrytan/gstack");
		expect(byName.get("qa-skill")?.installedFrom).toBe("mattpocock/skills");
	});

	it("normalizes a lock source URL to an owner/repo slug", async () => {
		await writeSkill("url-skill", { description: "u" });
		await writeLock({ "url-skill": "https://github.com/anthropics/skills.git" });

		const skills = await listSkills(workspace);
		expect(skills[0].installedFrom).toBe("anthropics/skills");
	});

	it("falls back to a legacy installedFrom frontmatter field when no lock entry exists", async () => {
		const dir = join(workspace, ".agents/skills/legacy");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "SKILL.md"),
			"---\nname: legacy\ndescription: d\ninstalledFrom: old/source\n---\n\nbody\n",
			"utf8",
		);

		const skills = await listSkills(workspace);
		expect(skills[0].installedFrom).toBe("old/source");
	});
});

describe("setSkillDisabled", () => {
	it("toggles the disabled flag while preserving body and other frontmatter", async () => {
		const dir = await writeSkill("toggle", { description: "keep me", body: "# Keep\nbody text" });

		await setSkillDisabled(workspace, "toggle", true);
		let md = await readFile(join(dir, "SKILL.md"), "utf8");
		let fm = frontmatterOf(md);
		expect(fm.disabled).toBe(true);
		expect(fm.description).toBe("keep me");
		expect(md).toContain("body text");

		await setSkillDisabled(workspace, "toggle", false);
		md = await readFile(join(dir, "SKILL.md"), "utf8");
		fm = frontmatterOf(md);
		expect(fm.disabled).toBe(false);
		expect(md).toContain("body text");
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

	it("stamps installedAt onto skills the lock attributes to the installed source", async () => {
		// The CLI is mocked (no-op), so simulate its effect: the skill files plus the
		// lock entry recording where they came from.
		const dir = await writeSkill("frontend-design", { description: "d" });
		await writeLock({ "frontend-design": "anthropics/skills" });

		await installSkill(workspace, "anthropics/skills", ["frontend-design"]);

		const fm = frontmatterOf(await readFile(join(dir, "SKILL.md"), "utf8"));
		// Grouping comes from the lock file, so installedFrom is NOT stamped into frontmatter.
		expect(fm.installedFrom).toBeUndefined();
		expect(typeof fm.installedAt).toBe("string");
		expect(Number.isNaN(Date.parse(fm.installedAt as string))).toBe(false);

		// And the skill is grouped under the lock's source.
		const skills = await listSkills(workspace);
		expect(skills.find((s) => s.name === "frontend-design")?.installedFrom).toBe("anthropics/skills");
	});

	it("does not re-stamp installedAt onto an unrelated source's skills", async () => {
		const otherDir = await writeSkill("other-skill", { description: "o" });
		const newDir = await writeSkill("new-skill", { description: "n" });
		await writeLock({ "other-skill": "garrytan/gstack", "new-skill": "mattpocock/skills" });

		await installSkill(workspace, "mattpocock/skills", ["new-skill"]);

		// The previously-installed source's skill is untouched (no installedAt added).
		expect(frontmatterOf(await readFile(join(otherDir, "SKILL.md"), "utf8")).installedAt).toBeUndefined();
		expect(typeof frontmatterOf(await readFile(join(newDir, "SKILL.md"), "utf8")).installedAt).toBe("string");
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
		await removeSkill(workspace, "gone");
		const args = findCliCall("remove");
		expect(args).toEqual(expect.arrayContaining(["skills", "remove", "gone", "--yes", "-p"]));
	});

	it("falls back to direct directory removal when the CLI errors", async () => {
		const dir = await writeSkill("manual", { description: "d" });
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[1] === "remove") {
				throw new Error("not found at project scope");
			}
			return { stdout: "" };
		});

		await removeSkill(workspace, "manual");
		await expect(readFile(join(dir, "SKILL.md"), "utf8")).rejects.toThrow();
	});
});
