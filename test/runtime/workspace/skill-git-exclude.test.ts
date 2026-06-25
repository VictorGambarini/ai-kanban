import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureSkillGitExcludes } from "../../../src/workspace/skill-git-exclude";

const execFileAsync = promisify(execFile);

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "skill-exclude-test-"));
	await execFileAsync("git", ["init", "-q"], { cwd: repo });
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("ensureSkillGitExcludes", () => {
	it("adds the managed skill block with root-anchored patterns to info/exclude", async () => {
		await ensureSkillGitExcludes(repo);
		const content = await readFile(join(repo, ".git/info/exclude"), "utf8");
		expect(content).toContain("# kanban-managed-skill-paths:start");
		expect(content).toContain("/.agents/skills/");
		expect(content).toContain("/.claude/skills/");
		expect(content).toContain("/.claude/settings.local.json");
		expect(content).toContain("/CLAUDE.local.md");
		expect(content).toContain("# kanban-managed-skill-paths:end");
	});

	it("is idempotent — repeated calls do not duplicate the block", async () => {
		await ensureSkillGitExcludes(repo);
		await ensureSkillGitExcludes(repo);
		const content = await readFile(join(repo, ".git/info/exclude"), "utf8");
		const occurrences = content.split("# kanban-managed-skill-paths:start").length - 1;
		expect(occurrences).toBe(1);
	});

	it("actually causes git to ignore an injected skill path", async () => {
		await ensureSkillGitExcludes(repo);
		// Simulate an injected skill file.
		await execFileAsync("mkdir", ["-p", join(repo, ".agents/skills/frontend-design")]);
		await execFileAsync("touch", [join(repo, ".agents/skills/frontend-design/SKILL.md")]);
		const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo });
		expect(stdout).not.toContain(".agents/skills");
	});

	it("no-ops outside a git repository", async () => {
		const nonRepo = await mkdtemp(join(tmpdir(), "skill-exclude-nonrepo-"));
		try {
			await expect(ensureSkillGitExcludes(nonRepo)).resolves.toBeUndefined();
		} finally {
			await rm(nonRepo, { recursive: true, force: true });
		}
	});
});
