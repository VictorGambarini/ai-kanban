import type { RemoteCommandResult } from "./host-types";

/** Runs a command on the remote host (typically backed by an SSH connection's `exec`). */
export type RemoteCommandRunner = (command: string) => Promise<RemoteCommandResult>;

/** Probes whether the remote runtime answers on its forwarded loopback port. */
export type RemoteRuntimeHealthCheck = () => Promise<boolean>;

export interface EnsureRemoteRuntimeOptions {
	/** Port the remote runtime should listen on (loopback on the van). */
	runtimePort: number;
	/** Remote binary name/path. Defaults to `ai-kanban`. */
	binary?: string;
	/** Extra arguments appended to the launch command. */
	extraArgs?: string[];
	/** Max time to wait for the runtime to become healthy after launch. */
	healthTimeoutMs?: number;
	/** Delay between health probes. */
	healthIntervalMs?: number;
	/** Injectable sleep, for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable clock, for tests. */
	now?: () => number;
}

export type RemoteRuntimeBootstrapOutcome = "already-running" | "launched";

export interface RemoteRuntimeBootstrapResult {
	outcome: RemoteRuntimeBootstrapOutcome;
	binary: string;
}

const DEFAULT_BINARY = "ai-kanban";
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quote a single shell argument safely for POSIX `sh`. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Build the command that launches the remote runtime, fully detached so the
 * SSH `exec` channel can close without killing it. Binds to loopback with the
 * passcode disabled — the tunnel is the trust boundary, and the hub reaches it
 * only through the forwarded port.
 */
function buildLaunchCommand(binary: string, runtimePort: number, extraArgs: string[]): string {
	const args = ["--host", "127.0.0.1", "--port", String(runtimePort), "--no-open", "--no-passcode", ...extraArgs];
	const quoted = [binary, ...args].map(shellQuote).join(" ");
	const logFile = "$HOME/.cline/kanban/remote-runtime.log";
	// `setsid` detaches from the SSH session so the process survives channel close.
	return `mkdir -p "$HOME/.cline/kanban" && setsid sh -c ${shellQuote(`${quoted} >> ${logFile} 2>&1`)} < /dev/null > /dev/null 2>&1 &`;
}

/**
 * Ensure an `ai-kanban` runtime is running on a remote host, launching it over
 * SSH if needed and polling the forwarded port until it answers.
 *
 * Does not install the binary: a missing binary is a hard, actionable error.
 */
export async function ensureRemoteRuntime(
	runner: RemoteCommandRunner,
	healthCheck: RemoteRuntimeHealthCheck,
	options: EnsureRemoteRuntimeOptions,
): Promise<RemoteRuntimeBootstrapResult> {
	const binary = options.binary ?? DEFAULT_BINARY;
	const extraArgs = options.extraArgs ?? [];
	const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
	const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;

	if (await healthCheck()) {
		return { outcome: "already-running", binary };
	}

	const whichResult = await runner(`command -v ${shellQuote(binary)} || true`);
	if (whichResult.stdout.trim().length === 0) {
		throw new Error(
			`Remote host does not have "${binary}" on its PATH. Install ai-kanban on the host (e.g. \`npm i -g @victorgambarini/ai-kanban\`) and try again.`,
		);
	}

	await runner(buildLaunchCommand(binary, options.runtimePort, extraArgs));

	const deadline = now() + healthTimeoutMs;
	for (;;) {
		await sleep(healthIntervalMs);
		if (await healthCheck()) {
			return { outcome: "launched", binary };
		}
		if (now() >= deadline) {
			throw new Error(
				`Remote runtime on this host did not become healthy within ${Math.round(healthTimeoutMs / 1000)}s after launch. Check ~/.cline/kanban/remote-runtime.log on the host.`,
			);
		}
	}
}

/**
 * Build a health check that probes the runtime's always-public passcode-status
 * endpoint through a forwarded loopback port on the hub.
 */
export function createForwardedPortHealthCheck(
	getLocalPort: () => number | null,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): RemoteRuntimeHealthCheck {
	return async () => {
		const localPort = getLocalPort();
		if (localPort === null) {
			return false;
		}
		try {
			const response = await fetchImpl(`http://127.0.0.1:${localPort}/api/passcode/status`, {
				method: "GET",
			});
			return response.ok;
		} catch {
			return false;
		}
	};
}
