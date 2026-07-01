import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getWorkspaceChanges } from "../../../src/workspace/get-workspace-changes";

const execFileAsync = promisify(execFile);

let repo: string;

async function commitAll(cwd: string, message: string): Promise<void> {
	await execFileAsync("git", ["add", "-A"], { cwd });
	await execFileAsync("git", ["commit", "-q", "-m", message], { cwd });
}

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "workspace-changes-test-"));
	await execFileAsync("git", ["init", "-q"], { cwd: repo });
	await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
	await writeFile(join(repo, "README.md"), "hello\n", "utf8");
	await commitAll(repo, "initial");
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("getWorkspaceChanges", () => {
	it("hides Kanban-injected skill files even when the exclude block was never written", async () => {
		// Simulate a project opened with a skill already dropped into .agents/skills/ but no
		// prior install/inject flow — i.e. .git/info/exclude has no managed block yet.
		const skillDir = join(repo, ".agents", "skills", "frontend-design");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "# skill\n".repeat(100), "utf8");

		const response = await getWorkspaceChanges(repo);

		expect(response.files.some((file) => file.path.startsWith(".agents/skills/"))).toBe(false);
		const excludeContent = await readFile(join(repo, ".git/info/exclude"), "utf8");
		expect(excludeContent).toContain("# kanban-managed-skill-paths:start");
	});

	it("still reports genuine untracked project files", async () => {
		await writeFile(join(repo, "notes.txt"), "todo\n", "utf8");

		const response = await getWorkspaceChanges(repo);

		const notes = response.files.find((file) => file.path === "notes.txt");
		expect(notes?.status).toBe("untracked");
	});
});
