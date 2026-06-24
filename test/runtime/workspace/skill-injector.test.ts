import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceSkill } from "../../../src/core/api-contract";

// Mock the skill service so the injector resolves skill directories without
// shelling out to the `npx skills` CLI. Filesystem copy behaviour is real.
const serviceMocks = vi.hoisted(() => ({ listSkills: vi.fn() }));
vi.mock("../../../src/workspace/workspace-skill-service", () => ({
	listSkills: serviceMocks.listSkills,
}));

import { injectSkillsForAgent } from "../../../src/workspace/skill-injector";

let root: string;
let workspace: string;
let worktree: string;

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

// Create a skill directory in the workspace and register it with the mocked
// listSkills so the injector can resolve it.
const registered: RuntimeWorkspaceSkill[] = [];
async function makeSkill(
	name: string,
	opts: { disabled?: boolean; extraFiles?: Record<string, string> } = {},
): Promise<void> {
	const dir = join(workspace, ".agents/skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`, "utf8");
	for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
		const target = join(dir, rel);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, content, "utf8");
	}
	registered.push({ name, description: `${name} desc`, disabled: opts.disabled ?? false, dirPath: dir });
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "skill-inject-test-"));
	workspace = join(root, "workspace");
	worktree = join(root, "worktree");
	await mkdir(workspace, { recursive: true });
	await mkdir(worktree, { recursive: true });
	registered.length = 0;
	serviceMocks.listSkills.mockReset();
	serviceMocks.listSkills.mockImplementation(async () => registered);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("injectSkillsForAgent – cline", () => {
	it("copies selected skills (incl. supporting files) into the worktree .agents/skills", async () => {
		await makeSkill("alpha", { extraFiles: { "helper.py": "print(1)\n", "templates/t.j2": "{{x}}\n" } });
		await makeSkill("beta");

		await injectSkillsForAgent("cline", worktree, workspace, ["alpha", "beta"]);

		expect(await exists(join(worktree, ".agents/skills/alpha/SKILL.md"))).toBe(true);
		expect(await exists(join(worktree, ".agents/skills/alpha/helper.py"))).toBe(true);
		expect(await exists(join(worktree, ".agents/skills/alpha/templates/t.j2"))).toBe(true);
		expect(await exists(join(worktree, ".agents/skills/beta/SKILL.md"))).toBe(true);
	});

	it("does not write Claude-specific paths", async () => {
		await makeSkill("alpha");
		await injectSkillsForAgent("cline", worktree, workspace, ["alpha"]);
		expect(await exists(join(worktree, ".claude/skills/alpha"))).toBe(false);
		expect(await exists(join(worktree, "CLAUDE.local.md"))).toBe(false);
	});
});

describe("injectSkillsForAgent – claude", () => {
	it("copies into both .agents/skills and .claude/skills and writes a CLAUDE.local.md index", async () => {
		await makeSkill("alpha", { extraFiles: { "helper.py": "x\n" } });
		await makeSkill("beta");

		await injectSkillsForAgent("claude", worktree, workspace, ["alpha", "beta"]);

		expect(await exists(join(worktree, ".agents/skills/alpha/SKILL.md"))).toBe(true);
		expect(await exists(join(worktree, ".claude/skills/alpha/SKILL.md"))).toBe(true);
		expect(await exists(join(worktree, ".claude/skills/alpha/helper.py"))).toBe(true);
		expect(await exists(join(worktree, ".claude/skills/beta/SKILL.md"))).toBe(true);

		const localMd = await readFile(join(worktree, "CLAUDE.local.md"), "utf8");
		expect(localMd).toContain("<!-- kanban-skills-start -->");
		expect(localMd).toContain("<!-- kanban-skills-end -->");
		expect(localMd).toContain("alpha");
		expect(localMd).toContain("beta");
	});
});

describe("injectSkillsForAgent – filtering & idempotency", () => {
	it("skips disabled skills even when explicitly requested", async () => {
		await makeSkill("alpha");
		await makeSkill("gamma", { disabled: true });

		await injectSkillsForAgent("claude", worktree, workspace, ["alpha", "gamma"]);

		expect(await exists(join(worktree, ".claude/skills/alpha"))).toBe(true);
		expect(await exists(join(worktree, ".claude/skills/gamma"))).toBe(false);
		const localMd = await readFile(join(worktree, "CLAUDE.local.md"), "utf8");
		expect(localMd).not.toContain("gamma");
	});

	it("replaces only the managed block in CLAUDE.local.md, preserving user content", async () => {
		await makeSkill("alpha");
		await writeFile(
			join(worktree, "CLAUDE.local.md"),
			"# My notes\nUser content.\n\n<!-- kanban-skills-start -->\nOLD\n<!-- kanban-skills-end -->\n\nTrailing notes.\n",
			"utf8",
		);

		await injectSkillsForAgent("claude", worktree, workspace, ["alpha"]);

		const localMd = await readFile(join(worktree, "CLAUDE.local.md"), "utf8");
		expect(localMd).toContain("# My notes");
		expect(localMd).toContain("Trailing notes.");
		expect(localMd).not.toContain("OLD");
		expect(localMd).toContain("alpha");
		expect(localMd.match(/kanban-skills-start/g)).toHaveLength(1);
	});
});

describe("injectSkillsForAgent – agents without an injector", () => {
	it("is a no-op for unregistered agents", async () => {
		await makeSkill("alpha");
		await injectSkillsForAgent("codex", worktree, workspace, ["alpha"]);
		expect(await exists(join(worktree, ".agents/skills/alpha"))).toBe(false);
	});
});
