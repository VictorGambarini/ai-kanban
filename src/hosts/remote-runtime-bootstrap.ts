import type { RemoteCommandResult } from "./host-types";

/** Runs a command on the remote host (typically backed by an SSH connection's `exec`). */
export type RemoteCommandRunner = (command: string) => Promise<RemoteCommandResult>;

/** Probes whether the remote runtime answers on its forwarded loopback port. */
export type RemoteRuntimeHealthCheck = () => Promise<boolean>;

export interface EnsureRemoteRuntimeOptions {
	/** Port the remote runtime should listen on (loopback on the VM). */
	runtimePort: number;
	/**
	 * npm package spec to run via `npx`, pinned to the hub's version, e.g.
	 * `@victorgambarini/ai-kanban@0.1.69`. When set, the runtime is launched with
	 * `npx -y <spec>` so the remote always runs the SAME version as the hub,
	 * avoiding hub/remote API drift. Requires `npx` (Node.js) on the remote.
	 * Takes precedence over {@link binary}.
	 */
	npxPackageSpec?: string;
	/** Remote binary name/path, used when {@link npxPackageSpec} is not set. Defaults to `ai-kanban`. */
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
// First npx run downloads a large package (Sentry, OpenTelemetry, MCP SDK, …),
// which can take several minutes on a slow link. Be generous so a cold start
// doesn't time out before the runtime comes up.
const DEFAULT_NPX_HEALTH_TIMEOUT_MS = 300_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quote a single shell argument safely for POSIX `sh`. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The runtime flags every remote launch needs, regardless of how it's invoked. */
function buildRuntimeArgs(runtimePort: number, extraArgs: string[]): string[] {
	return ["--host", "127.0.0.1", "--port", String(runtimePort), "--no-open", "--no-passcode", ...extraArgs];
}

/**
 * Build the command that launches the remote runtime, fully detached so the
 * SSH `exec` channel can close without killing it. Binds to loopback with the
 * passcode disabled — the tunnel is the trust boundary, and the hub reaches it
 * only through the forwarded port.
 */
function buildLaunchCommand(commandTokens: string[]): string {
	const quoted = commandTokens.map(shellQuote).join(" ");
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
	const useNpx = Boolean(options.npxPackageSpec);
	const extraArgs = options.extraArgs ?? [];
	// First npx run downloads the package, so allow more time before giving up.
	const healthTimeoutMs =
		options.healthTimeoutMs ?? (useNpx ? DEFAULT_NPX_HEALTH_TIMEOUT_MS : DEFAULT_HEALTH_TIMEOUT_MS);
	const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;

	// What we report we launched: the pinned package spec, or the direct binary.
	const launched = useNpx ? (options.npxPackageSpec as string) : binary;

	if (await healthCheck()) {
		return { outcome: "already-running", binary: launched };
	}

	// npx mode needs Node's `npx` on PATH (it fetches/runs the pinned version);
	// binary mode needs the `ai-kanban` binary itself.
	const probeBinary = useNpx ? "npx" : binary;
	const whichResult = await runner(`command -v ${shellQuote(probeBinary)} || true`);
	if (whichResult.stdout.trim().length === 0) {
		throw new Error(
			useNpx
				? `Remote host does not have "npx" on its PATH. Install Node.js on the host (npx ships with npm) and try again.`
				: `Remote host does not have "${binary}" on its PATH. Install ai-kanban on the host (e.g. \`npm i -g @victorgambarini/ai-kanban\`) and try again.`,
		);
	}

	const runtimeArgs = buildRuntimeArgs(options.runtimePort, extraArgs);
	const commandTokens = useNpx
		? ["npx", "-y", options.npxPackageSpec as string, ...runtimeArgs]
		: [binary, ...runtimeArgs];
	await runner(buildLaunchCommand(commandTokens));

	const deadline = now() + healthTimeoutMs;
	for (;;) {
		await sleep(healthIntervalMs);
		if (await healthCheck()) {
			return { outcome: "launched", binary: launched };
		}
		if (now() >= deadline) {
			const firstRunHint = useNpx
				? " The first launch downloads the package, which can be slow on the host's network; retrying often succeeds once npx has cached it."
				: "";
			throw new Error(
				`Remote runtime on this host did not become healthy within ${Math.round(healthTimeoutMs / 1000)}s after launch.${firstRunHint} Check ~/.cline/kanban/remote-runtime.log on the host.`,
			);
		}
	}
}

/**
 * Read the remote runtime's reported version through a forwarded loopback port,
 * via its always-public `/api/version` endpoint. Returns null if unreachable or
 * if the remote is too old to expose the endpoint.
 */
export async function fetchRemoteRuntimeVersion(
	localPort: number,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
	try {
		const response = await fetchImpl(`http://127.0.0.1:${localPort}/api/version`, { method: "GET" });
		if (!response.ok) {
			return null;
		}
		const data = (await response.json()) as { version?: unknown };
		return typeof data.version === "string" ? data.version : null;
	} catch {
		return null;
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
