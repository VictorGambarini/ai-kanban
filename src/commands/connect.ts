import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type AddressInfo, createServer as createNetServer, connect as netConnect } from "node:net";

import type { Command } from "commander";
import { Client as Ssh2Client } from "ssh2";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const RUNTIME_READY_TIMEOUT_MS = 60_000;

interface ConnectOptions {
	hub: string;
	hostId: string;
	token: string;
	runtimePort?: string;
	fingerprint?: string;
	runtime?: boolean;
}

function printLine(message: string): void {
	process.stdout.write(`${message}\n`);
}

/** Parse `host:port` (the hub's rendezvous endpoint). */
function parseHubEndpoint(value: string): { host: string; port: number } {
	const separator = value.lastIndexOf(":");
	if (separator <= 0) {
		throw new Error(`Invalid --hub "${value}". Expected host:port (e.g. vm.tailnet.ts.net:3485).`);
	}
	const host = value.slice(0, separator);
	const port = Number.parseInt(value.slice(separator + 1), 10);
	if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid --hub "${value}". Expected host:port with a port from 1-65535.`);
	}
	return { host, port };
}

/** Fingerprint an SSH host-key blob the same way the rendezvous server prints it. */
function fingerprintKey(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

async function findFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createNetServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			server.close(() => resolve(port));
		});
	});
}

/** Poll the local runtime until it answers, so we don't tunnel to a not-yet-ready server. */
async function waitForRuntime(port: number): Promise<void> {
	const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/version`);
			if (response.ok) {
				return;
			}
		} catch {
			// Not up yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Local runtime on port ${port} did not become ready within ${RUNTIME_READY_TIMEOUT_MS / 1000}s.`);
}

function startLocalRuntime(port: number): ChildProcess {
	// Re-invoke this CLI in server mode, bound to loopback with the passcode disabled —
	// the rendezvous tunnel is the trust boundary and the port is never published.
	return spawn(
		process.execPath,
		[process.argv[1], "--host", "127.0.0.1", "--port", String(port), "--no-open", "--no-passcode"],
		{ stdio: "inherit" },
	);
}

/**
 * Run one attach cycle: connect to the hub rendezvous, reverse-forward the local
 * runtime, and stay up until the connection drops. Resolves when the connection
 * closes (so the caller can reconnect); rejects on a fatal auth/setup error.
 */
function attachOnce(
	client: Ssh2Client,
	input: {
		endpoint: { host: string; port: number };
		username: string;
		token: string;
		fingerprint?: string;
		runtimePort: number;
	},
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const settle = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};

		client.on("ready", () => {
			printLine("Connected to hub. Reverse-forwarding local runtime…");
			client.forwardIn("127.0.0.1", 0, (error) => {
				if (error) {
					settle(new Error(`Failed to set up reverse forward: ${error.message}`));
					client.end();
				}
			});
		});

		client.on("tcp connection", (_info, accept) => {
			const channel = accept();
			const socket = netConnect(input.runtimePort, "127.0.0.1");
			socket.on("error", () => channel.close());
			channel.on("error", () => socket.destroy());
			socket.pipe(channel).pipe(socket);
		});

		client.on("error", (error) => settle(error));
		client.on("close", () => settle());

		client.connect({
			host: input.endpoint.host,
			port: input.endpoint.port,
			username: input.username,
			password: input.token,
			keepaliveInterval: KEEPALIVE_INTERVAL_MS,
			hostVerifier: (key: Buffer) => {
				const actual = fingerprintKey(key);
				if (!input.fingerprint) {
					printLine(`Hub host key fingerprint: ${actual} (pin it with --fingerprint to prevent MITM).`);
					return true;
				}
				if (actual !== input.fingerprint) {
					printLine(`Hub host key mismatch! expected ${input.fingerprint}, got ${actual}. Refusing to connect.`);
					return false;
				}
				return true;
			},
		});
	});
}

export function registerConnectCommand(program: Command): void {
	program
		.command("connect")
		.description("Attach this machine to a hub as a reverse (dial-in) execution target.")
		.requiredOption("--hub <host:port>", "Hub rendezvous endpoint, e.g. vm.tailnet.ts.net:3485.")
		.requiredOption("--host-id <id>", "The reverse host id shown when you created it in the hub.")
		.requiredOption("--token <token>", "The one-time pairing token shown when you created the host.")
		.option("--runtime-port <number>", "Local runtime port to expose (default: an ephemeral free port).")
		.option("--fingerprint <sha256>", "Hub host-key fingerprint to pin (recommended).")
		.option("--no-runtime", "Do not start a local runtime; tunnel to an existing one on --runtime-port.")
		.action(async (options: ConnectOptions) => {
			const endpoint = parseHubEndpoint(options.hub);
			const runtimePort = options.runtimePort ? Number.parseInt(options.runtimePort, 10) : await findFreePort();
			if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) {
				throw new Error(`Invalid --runtime-port "${options.runtimePort}".`);
			}

			let stopping = false;
			let activeClient: Ssh2Client | null = null;
			const shutdown = () => {
				if (stopping) {
					return;
				}
				stopping = true;
				printLine("Disconnecting…");
				activeClient?.end();
			};

			let runtimeChild: ChildProcess | null = null;
			if (options.runtime !== false) {
				printLine(`Starting local runtime on 127.0.0.1:${runtimePort}…`);
				runtimeChild = startLocalRuntime(runtimePort);
				runtimeChild.on("exit", (code) => {
					printLine(`Local runtime exited (code ${code ?? "unknown"}). Stopping connector.`);
					process.exitCode = code ?? 1;
					shutdown();
				});
			}
			await waitForRuntime(runtimePort);

			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);

			// Supervise: reconnect with exponential backoff until stopped. When the action
			// returns, the CLI entrypoint (run() in cli.ts) exits the process.
			let attempt = 0;
			while (!stopping) {
				const client = new Ssh2Client();
				activeClient = client;
				try {
					await attachOnce(client, {
						endpoint,
						username: `${options.hostId}:${runtimePort}`,
						token: options.token,
						fingerprint: options.fingerprint,
						runtimePort,
					});
					attempt = 0; // A clean close (not an error) resets backoff.
				} catch (error) {
					printLine(`Connection lost: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					activeClient = null;
				}
				if (stopping) {
					break;
				}
				const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
				attempt += 1;
				printLine(`Reconnecting in ${Math.round(delay / 1000)}s…`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
			runtimeChild?.kill();
		});
}
