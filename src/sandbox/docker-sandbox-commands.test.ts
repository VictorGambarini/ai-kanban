import { describe, expect, it } from "vitest";

import {
	buildAgentExecArgs,
	buildComposeUpArgs,
	buildSandboxRemoveArgs,
	buildSandboxRunArgs,
	resolveSandboxProfile,
	sandboxContainerName,
} from "./docker-sandbox-commands";
import { buildSandboxAgentCommand } from "./sandbox-manager";

describe("sandboxContainerName", () => {
	it("prefixes and lowercases task ids to a docker-safe name", () => {
		expect(sandboxContainerName("Task_ABC-123")).toBe("kanban-task-task_abc-123");
	});

	it("replaces unsafe characters with dashes", () => {
		expect(sandboxContainerName("a/b c:d")).toBe("kanban-task-a-b-c-d");
	});
});

describe("buildSandboxRunArgs", () => {
	it("creates a detached container with the Sysbox runtime and bind-mounted worktree by default", () => {
		const args = buildSandboxRunArgs({
			container: "kanban-task-x",
			image: "kanban/sandbox:latest",
			worktreeHostPath: "/home/u/.cline/worktrees/x/repo",
		});
		expect(args).toEqual([
			"run",
			"-d",
			"--name",
			"kanban-task-x",
			"--runtime",
			"sysbox-runc",
			"-v",
			"/home/u/.cline/worktrees/x/repo:/workspace",
			"-w",
			"/workspace",
			"kanban/sandbox:latest",
			"sleep",
			"infinity",
		]);
	});

	it("honors an explicit runtime override", () => {
		const args = buildSandboxRunArgs({
			container: "c",
			image: "img",
			worktreeHostPath: "/w",
			runtime: "runc",
		});
		expect(args).toContain("runc");
		expect(args).not.toContain("sysbox-runc");
	});
});

describe("buildComposeUpArgs", () => {
	it("runs `docker compose up -d` inside the sandbox with a per-task project name", () => {
		expect(
			buildComposeUpArgs({
				container: "kanban-task-x",
				composeFile: "docker-compose.yml",
				projectName: "kanban-task-x",
			}),
		).toEqual([
			"exec",
			"kanban-task-x",
			"bash",
			"-lc",
			"docker compose -p 'kanban-task-x' -f 'docker-compose.yml' up -d",
		]);
	});
});

describe("buildAgentExecArgs", () => {
	it("execs the agent in the workdir and injects per-task env via -e", () => {
		const args = buildAgentExecArgs({
			container: "kanban-task-x",
			binary: "claude",
			args: ["--flag", "value"],
			envMap: { FOO: "bar", SKIP: undefined },
		});
		expect(args).toEqual([
			"exec",
			"-i",
			"-t",
			"-w",
			"/workspace",
			"-e",
			"FOO=bar",
			"kanban-task-x",
			"claude",
			"--flag",
			"value",
		]);
	});
});

describe("buildSandboxRemoveArgs", () => {
	it("force-removes the container", () => {
		expect(buildSandboxRemoveArgs("kanban-task-x")).toEqual(["rm", "-f", "kanban-task-x"]);
	});
});

describe("resolveSandboxProfile", () => {
	it("defaults the runtime to sysbox-runc", () => {
		expect(resolveSandboxProfile({ id: "p", label: "P", image: "img" }).runtime).toBe("sysbox-runc");
	});
});

describe("buildSandboxAgentCommand", () => {
	it("wraps the agent command into a docker exec invocation", () => {
		const command = buildSandboxAgentCommand({
			wrapper: { container: "kanban-task-x", workdir: "/workspace" },
			binary: "claude",
			args: ["--resume"],
			envMap: { API_KEY: "secret" },
		});
		expect(command.binary).toBe("docker");
		expect(command.args).toEqual([
			"exec",
			"-i",
			"-t",
			"-w",
			"/workspace",
			"-e",
			"API_KEY=secret",
			"kanban-task-x",
			"claude",
			"--resume",
		]);
	});
});
