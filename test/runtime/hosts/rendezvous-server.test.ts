import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer, connect as netConnect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client as Ssh2Client } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerReverseHost } from "../../../src/hosts/host-registry";
import { HostsManager } from "../../../src/hosts/hosts-manager";
import { RendezvousServer } from "../../../src/hosts/rendezvous-server";

let tempHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-rendezvous-"));
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
});

afterEach(() => {
	process.env.HOME = previousHome;
	process.env.USERPROFILE = previousUserProfile;
	rmSync(tempHome, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
});

/** A loopback echo server standing in for the connector's local runtime. */
function startEchoServer(): Promise<{ port: number; close: () => void }> {
	return new Promise((resolve) => {
		const server = createNetServer((socket) => socket.pipe(socket));
		server.listen(0, "127.0.0.1", () => {
			resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() });
		});
	});
}

describe("RendezvousServer", () => {
	it("authenticates a connector and tunnels hub traffic to the runtime end-to-end", async () => {
		const manager = new HostsManager({ autoBootstrap: false });
		const { host, token } = await registerReverseHost({ label: "Laptop" });
		const echo = await startEchoServer();

		const rendezvous = new RendezvousServer({ hostsManager: manager, port: 0, bindAddress: "127.0.0.1" });
		await rendezvous.start();
		const rendezvousPort = rendezvous.getPort();
		expect(rendezvousPort).toBeGreaterThan(0);
		expect(rendezvous.getHostKeyFingerprint()).toMatch(/^SHA256:/);

		const client = new Ssh2Client();
		const clientListeners: Array<Server> = [];
		try {
			await new Promise<void>((resolve, reject) => {
				client.on("ready", () => {
					client.forwardIn("127.0.0.1", 0, (error) => (error ? reject(error) : resolve()));
				});
				client.on("tcp connection", (_info, accept) => {
					const channel = accept();
					const socket = netConnect(echo.port, "127.0.0.1");
					socket.on("error", () => channel.close());
					socket.pipe(channel).pipe(socket);
				});
				client.on("error", reject);
				client.connect({
					host: "127.0.0.1",
					port: rendezvousPort ?? 0,
					username: `${host.id}:${echo.port}`,
					password: token,
					hostVerifier: () => true,
				});
			});

			// The connector attached: the hub now has a forwarded port and the runtime port.
			expect(manager.getForwardedPort(host.id)).toBeGreaterThan(0);
			expect(manager.getRuntimePort(host.id)).toBe(echo.port);

			// Traffic sent to the hub's forwarded port reaches the echo "runtime" and returns.
			const forwardedPort = manager.getForwardedPort(host.id) ?? 0;
			const roundTrip = await new Promise<string>((resolve, reject) => {
				const socket = netConnect(forwardedPort, "127.0.0.1");
				let received = "";
				socket.on("data", (chunk) => {
					received += chunk.toString("utf8");
					if (received.length >= 4) {
						socket.end();
						resolve(received);
					}
				});
				socket.on("error", reject);
				socket.on("connect", () => socket.write("ping"));
			});
			expect(roundTrip).toBe("ping");
		} finally {
			for (const listener of clientListeners) {
				listener.close();
			}
			client.end();
			rendezvous.close();
			echo.close();
		}
	});

	it("rejects a connector with a bad token", async () => {
		const manager = new HostsManager({ autoBootstrap: false });
		const { host } = await registerReverseHost({ label: "Laptop" });

		const rendezvous = new RendezvousServer({ hostsManager: manager, port: 0, bindAddress: "127.0.0.1" });
		await rendezvous.start();

		const client = new Ssh2Client();
		try {
			await expect(
				new Promise<void>((resolve, reject) => {
					client.on("ready", () => resolve());
					client.on("error", reject);
					client.connect({
						host: "127.0.0.1",
						port: rendezvous.getPort() ?? 0,
						username: `${host.id}:3486`,
						password: "wrong-token",
						hostVerifier: () => true,
					});
				}),
			).rejects.toThrow();
			expect(manager.getForwardedPort(host.id)).toBeNull();
		} finally {
			client.end();
			rendezvous.close();
		}
	});
});
