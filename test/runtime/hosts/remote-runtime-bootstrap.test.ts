import { describe, expect, it, vi } from "vitest";

import type { RemoteCommandResult } from "../../../src/hosts/host-types";
import {
	createForwardedPortHealthCheck,
	ensureRemoteRuntime,
	type RemoteCommandRunner,
} from "../../../src/hosts/remote-runtime-bootstrap";

function ok(stdout = ""): RemoteCommandResult {
	return { code: 0, signal: null, stdout, stderr: "" };
}

const noSleep = () => Promise.resolve();

describe("ensureRemoteRuntime", () => {
	it("returns already-running without launching when the runtime is healthy", async () => {
		const runner = vi.fn<RemoteCommandRunner>();
		const result = await ensureRemoteRuntime(runner, () => Promise.resolve(true), {
			runtimePort: 3484,
			sleep: noSleep,
		});
		expect(result.outcome).toBe("already-running");
		expect(runner).not.toHaveBeenCalled();
	});

	it("launches the runtime and resolves once it becomes healthy", async () => {
		const commands: string[] = [];
		const runner: RemoteCommandRunner = (command) => {
			commands.push(command);
			// `command -v` probe finds the binary.
			return Promise.resolve(ok(command.includes("command -v") ? "/usr/bin/ai-kanban" : ""));
		};
		let healthy = false;
		const healthCheck = vi.fn(() => {
			const value = healthy;
			healthy = true; // becomes healthy on the second probe
			return Promise.resolve(value);
		});

		const result = await ensureRemoteRuntime(runner, healthCheck, {
			runtimePort: 3484,
			sleep: noSleep,
		});

		expect(result.outcome).toBe("launched");
		expect(commands.some((command) => command.includes("command -v"))).toBe(true);
		const launchCommand = commands.find((command) => command.includes("setsid"));
		expect(launchCommand).toBeDefined();
		expect(launchCommand).toContain("127.0.0.1");
		expect(launchCommand).toContain("3484");
		expect(launchCommand).toContain("--no-passcode");
		expect(launchCommand).toContain("ai-kanban");
	});

	it("throws an actionable error when the binary is missing", async () => {
		const runner: RemoteCommandRunner = () => Promise.resolve(ok("")); // empty `command -v` output
		await expect(
			ensureRemoteRuntime(runner, () => Promise.resolve(false), { runtimePort: 3484, sleep: noSleep }),
		).rejects.toThrow(/does not have "ai-kanban" on its PATH/);
	});

	it("launches a version-pinned package via npx when npxPackageSpec is set", async () => {
		const commands: string[] = [];
		const runner: RemoteCommandRunner = (command) => {
			commands.push(command);
			// `command -v npx` probe finds npx.
			return Promise.resolve(ok(command.includes("command -v") ? "/usr/bin/npx" : ""));
		};
		let healthy = false;
		const healthCheck = vi.fn(() => {
			const value = healthy;
			healthy = true;
			return Promise.resolve(value);
		});

		const result = await ensureRemoteRuntime(runner, healthCheck, {
			runtimePort: 3484,
			npxPackageSpec: "@victorgambarini/ai-kanban@0.1.69",
			sleep: noSleep,
		});

		expect(result.outcome).toBe("launched");
		expect(result.binary).toBe("@victorgambarini/ai-kanban@0.1.69");
		// Probe must target npx, not the ai-kanban binary.
		expect(commands.some((command) => command.includes("command -v 'npx'"))).toBe(true);
		const launchCommand = commands.find((command) => command.includes("setsid"));
		expect(launchCommand).toBeDefined();
		expect(launchCommand).toContain("npx");
		expect(launchCommand).toContain("-y");
		expect(launchCommand).toContain("@victorgambarini/ai-kanban@0.1.69");
		expect(launchCommand).toContain("--no-passcode");
		expect(launchCommand).toContain("3484");
	});

	it("throws a Node-specific error when npx is missing in npx mode", async () => {
		const runner: RemoteCommandRunner = () => Promise.resolve(ok("")); // empty `command -v` output
		await expect(
			ensureRemoteRuntime(runner, () => Promise.resolve(false), {
				runtimePort: 3484,
				npxPackageSpec: "@victorgambarini/ai-kanban@0.1.69",
				sleep: noSleep,
			}),
		).rejects.toThrow(/does not have "npx" on its PATH/);
	});

	it("times out if the runtime never becomes healthy after launch", async () => {
		const runner: RemoteCommandRunner = (command) =>
			Promise.resolve(ok(command.includes("command -v") ? "/usr/bin/ai-kanban" : ""));
		let clock = 0;
		await expect(
			ensureRemoteRuntime(runner, () => Promise.resolve(false), {
				runtimePort: 3484,
				healthTimeoutMs: 3000,
				healthIntervalMs: 1000,
				sleep: noSleep,
				now: () => {
					clock += 1500;
					return clock;
				},
			}),
		).rejects.toThrow(/did not become healthy/);
	});
});

describe("createForwardedPortHealthCheck", () => {
	it("returns false when there is no forwarded port", async () => {
		const check = createForwardedPortHealthCheck(() => null, vi.fn());
		await expect(check()).resolves.toBe(false);
	});

	it("probes the passcode status endpoint on the forwarded port", async () => {
		const fetchImpl = vi.fn(() => Promise.resolve({ ok: true } as Response));
		const check = createForwardedPortHealthCheck(() => 51234, fetchImpl);
		await expect(check()).resolves.toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:51234/api/passcode/status", { method: "GET" });
	});

	it("treats fetch errors as unhealthy", async () => {
		const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
		const check = createForwardedPortHealthCheck(() => 51234, fetchImpl);
		await expect(check()).resolves.toBe(false);
	});
});
