import { DEFAULT_SANDBOX_RUNTIME, type DockerSandboxProfile, SANDBOX_WORKDIR } from "./docker-sandbox-types";

/**
 * Pure builders for the `docker` argument vectors the sandbox manager runs. Kept
 * separate from the imperative manager so the command shapes are unit-testable
 * without a Docker daemon.
 */

/** Derive a stable, docker-safe container / compose-project name for a task. */
export function sandboxContainerName(taskId: string): string {
	const safe = taskId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
	return `kanban-task-${safe}`;
}

/** `docker run` args to create the detached, long-lived sandbox container. */
export function buildSandboxRunArgs(input: {
	container: string;
	image: string;
	worktreeHostPath: string;
	runtime?: string;
}): string[] {
	return [
		"run",
		"-d",
		"--name",
		input.container,
		"--runtime",
		input.runtime?.trim() || DEFAULT_SANDBOX_RUNTIME,
		"-v",
		`${input.worktreeHostPath}:${SANDBOX_WORKDIR}`,
		"-w",
		SANDBOX_WORKDIR,
		input.image,
		// Sysbox starts the inner dockerd via the image's init/systemd; keep the
		// container alive so we can `docker exec` the compose stack + agent into it.
		"sleep",
		"infinity",
	];
}

/** `docker exec` (inside the sandbox) to bring the project's compose stack up. */
export function buildComposeUpArgs(input: { container: string; composeFile: string; projectName: string }): string[] {
	// Runs *inside* the sandbox's own Docker engine, so published ports bind there
	// and can't collide with the host or other tasks. The compose file is used verbatim.
	const inner = `docker compose -p ${shellQuote(input.projectName)} -f ${shellQuote(input.composeFile)} up -d`;
	return ["exec", input.container, "bash", "-lc", inner];
}

/** `docker exec` args to launch the agent process inside the sandbox. */
export function buildAgentExecArgs(input: {
	container: string;
	binary: string;
	args: string[];
	envMap?: Record<string, string | undefined>;
	workdir?: string;
}): string[] {
	const execArgs = ["exec", "-i", "-t", "-w", input.workdir?.trim() || SANDBOX_WORKDIR];
	for (const [key, value] of Object.entries(input.envMap ?? {})) {
		if (value !== undefined) {
			execArgs.push("-e", `${key}=${value}`);
		}
	}
	execArgs.push(input.container, input.binary, ...input.args);
	return execArgs;
}

/** `docker rm -f` args to tear the sandbox (and its inner engine + stack) down. */
export function buildSandboxRemoveArgs(container: string): string[] {
	return ["rm", "-f", container];
}

/** `docker inspect` args used to check whether the sandbox already exists. */
export function buildSandboxInspectArgs(container: string): string[] {
	return ["inspect", "--type", "container", container];
}

/** Resolve a profile's effective image/runtime, applying defaults. */
export function resolveSandboxProfile(
	profile: DockerSandboxProfile,
): Required<Pick<DockerSandboxProfile, "runtime">> & DockerSandboxProfile {
	return { ...profile, runtime: profile.runtime?.trim() || DEFAULT_SANDBOX_RUNTIME };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
