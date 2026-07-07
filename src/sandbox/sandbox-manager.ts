import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
	buildAgentExecArgs,
	buildComposeUpArgs,
	buildSandboxInspectArgs,
	buildSandboxRemoveArgs,
	buildSandboxRunArgs,
	resolveSandboxProfile,
	sandboxContainerName,
} from "./docker-sandbox-commands";
import { type DockerSandboxProfile, SANDBOX_WORKDIR } from "./docker-sandbox-types";

const execFileAsync = promisify(execFile);

/**
 * Task ids we've stood a sandbox up for in this runtime process. Lets teardown be a
 * true no-op for the overwhelming majority of tasks (local/remote), which never
 * touch Docker — so stop/cleanup paths can call teardown unconditionally.
 */
const activeSandboxTaskIds = new Set<string>();

/** How a running task's agent should be `docker exec`'d into its sandbox. */
export interface SandboxExecWrapper {
	container: string;
	workdir: string;
}

async function runDocker(args: string[], timeoutMs = 600_000): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

/** True when the Sysbox runtime is registered with the local Docker daemon. */
export async function isSysboxAvailable(): Promise<boolean> {
	try {
		const { stdout } = await runDocker(["info", "--format", "{{json .Runtimes}}"], 15_000);
		return stdout.includes("sysbox-runc");
	} catch {
		return false;
	}
}

async function sandboxExists(container: string): Promise<boolean> {
	try {
		await runDocker(buildSandboxInspectArgs(container), 15_000);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure a per-task Sysbox sandbox exists and (if the profile defines a compose
 * file) its stack is up, then return how to `docker exec` the agent into it. The
 * worktree is bind-mounted from the hub filesystem, so worktree creation is
 * unchanged — the container just runs against it.
 */
export async function ensureSandbox(input: {
	taskId: string;
	worktreeHostPath: string;
	profile: DockerSandboxProfile;
}): Promise<SandboxExecWrapper> {
	const container = sandboxContainerName(input.taskId);
	const profile = resolveSandboxProfile(input.profile);

	if (!(await sandboxExists(container))) {
		await runDocker(
			buildSandboxRunArgs({
				container,
				image: profile.image,
				worktreeHostPath: input.worktreeHostPath,
				runtime: profile.runtime,
			}),
		);
		if (profile.composeFile) {
			await runDocker(buildComposeUpArgs({ container, composeFile: profile.composeFile, projectName: container }));
		}
	}

	activeSandboxTaskIds.add(input.taskId);
	return { container, workdir: SANDBOX_WORKDIR };
}

/** Build the `docker exec` argv that launches the agent inside a sandbox. */
export function buildSandboxAgentCommand(input: {
	wrapper: SandboxExecWrapper;
	binary: string;
	args: string[];
	envMap?: Record<string, string | undefined>;
}): { binary: string; args: string[] } {
	return {
		binary: "docker",
		args: buildAgentExecArgs({
			container: input.wrapper.container,
			binary: input.binary,
			args: input.args,
			envMap: input.envMap,
			workdir: input.wrapper.workdir,
		}),
	};
}

/**
 * Remove a task's sandbox container (kills its inner engine + compose stack).
 * No-op — without spawning `docker` — when this runtime never created a sandbox
 * for the task, so stop/cleanup paths can call it unconditionally.
 */
export async function teardownSandbox(taskId: string): Promise<void> {
	if (!activeSandboxTaskIds.has(taskId)) {
		return;
	}
	activeSandboxTaskIds.delete(taskId);
	const container = sandboxContainerName(taskId);
	try {
		await runDocker(buildSandboxRemoveArgs(container), 60_000);
	} catch {
		// Best-effort: a missing container is already "torn down".
	}
}
