import { z } from "zod";

/**
 * A reusable definition of how to build a per-task Docker sandbox. Each task
 * targeted at `docker:<id>` gets its own container running with the Sysbox
 * runtime (an isolated inner Docker engine), so the project's **unmodified**
 * `docker compose` stack runs exactly as it would on a laptop — `localhost:PORT`
 * resolves inside the task's own engine and parallel tasks never collide on host
 * ports.
 */
export interface DockerSandboxProfile {
	id: string;
	label: string;
	/**
	 * Image for the sandbox container. Must include the Docker CLI + daemon (for
	 * Sysbox nested Docker) and the agent CLI(s) you intend to run. Defaults are
	 * applied by the runtime when omitted.
	 */
	image: string;
	/**
	 * Path (relative to the repo root) to the compose file to bring up inside the
	 * sandbox, e.g. `docker-compose.yml`. When omitted, no stack is started and the
	 * agent simply runs inside the sandbox against the bind-mounted worktree.
	 */
	composeFile?: string;
	/**
	 * Container runtime to use. Defaults to `sysbox-runc` (unprivileged nested
	 * Docker). Override to `runc` only if you accept privileged Docker-in-Docker.
	 */
	runtime?: string;
}

export const dockerSandboxProfileSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	image: z.string().min(1),
	composeFile: z.string().min(1).optional(),
	runtime: z.string().min(1).optional(),
});

export const dockerSandboxProfilesSchema = z.array(dockerSandboxProfileSchema);

/** Applied when a profile omits fields. */
export const DEFAULT_SANDBOX_RUNTIME = "sysbox-runc";
/** Mount point of the bind-mounted worktree inside the sandbox. */
export const SANDBOX_WORKDIR = "/workspace";
