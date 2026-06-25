import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// ── Mock the npx skills CLI (`skills list`, `skills add`, `skills remove`) ──
// Only the subprocess boundary is mocked; all filesystem work runs for real
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

import {
	createSkill,
	installSkill,
	listSkills,
	removeSkill,
	setSkillDisabled,
} from "../../../src/workspace/workspace-skill-service";

let workspace: string;

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

// Map the mocked `skills list --json` output to whatever skills currently exist
// on disk in the temp workspace's project-scoped .agents/skills directory.
function mockListReturns(entries: Array<{ name: string; path: string }>): void {
	childProcessMocks.execFilePromise.mockImplementation(async (_binary: string, args: string[]) => {
		if (args[0] === "skills" && args[1] === "list") {
			const isProject = args.includes("-p");
			return {
				stdout: isProject ? JSON.stringify(entries.map((e) => ({ ...e, scope: "project", agents: [] }))) : "[]",
			};
		}
		return { stdout: "" };
	});
}

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), "skill-svc-test-"));
	childProcessMocks.execFilePromise.mockReset();
	childProcessMocks.execFilePromise.mockResolvedValue({ stdout: "[]" });
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
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

describe("listSkills + frontmatter parsing", () => {
	it("reads description and disabled flag from each skill's SKILL.md", async () => {
		await createSkill(workspace, { name: "alpha", description: "Alpha desc", instructions: "a" });
		const alphaDir = join(workspace, ".agents/skills/alpha");
		mockListReturns([{ name: "alpha", path: alphaDir }]);

		const skills = await listSkills(workspace);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "alpha",
			description: "Alpha desc",
			disabled: false,
			dirPath: alphaDir,
		});
	});

	it("deduplicates skills returned by multiple scopes", async () => {
		await createSkill(workspace, { name: "dup", description: "d", instructions: "x" });
		const dupDir = join(workspace, ".agents/skills/dup");
		// Both -p and -g return the same skill; listSkills should keep one.
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[0] === "skills" && args[1] === "list") {
				return { stdout: JSON.stringify([{ name: "dup", path: dupDir, scope: "project", agents: [] }]) };
			}
			return { stdout: "" };
		});

		const skills = await listSkills(workspace);
		expect(skills.filter((s) => s.name === "dup")).toHaveLength(1);
	});
});

describe("setSkillDisabled", () => {
	it("toggles the disabled flag while preserving body and other frontmatter", async () => {
		await createSkill(workspace, { name: "toggle", description: "keep me", instructions: "# Keep\nbody text" });
		const dir = join(workspace, ".agents/skills/toggle");
		mockListReturns([{ name: "toggle", path: dir }]);

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
		mockListReturns([]);
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
});

describe("removeSkill", () => {
	it("calls the CLI remove command at project scope", async () => {
		await removeSkill(workspace, "gone");
		const args = findCliCall("remove");
		expect(args).toEqual(expect.arrayContaining(["skills", "remove", "gone", "--yes", "-p"]));
	});

	it("falls back to direct directory removal when the CLI errors", async () => {
		await createSkill(workspace, { name: "manual", instructions: "x" });
		const dir = join(workspace, ".agents/skills/manual");
		childProcessMocks.execFilePromise.mockImplementation(async (_b: string, args: string[]) => {
			if (args[1] === "remove") {
				throw new Error("not found at project scope");
			}
			if (args[1] === "list") {
				return { stdout: JSON.stringify([{ name: "manual", path: dir, scope: "project", agents: [] }]) };
			}
			return { stdout: "" };
		});

		await removeSkill(workspace, "manual");
		await expect(readFile(join(dir, "SKILL.md"), "utf8")).rejects.toThrow();
	});
});
