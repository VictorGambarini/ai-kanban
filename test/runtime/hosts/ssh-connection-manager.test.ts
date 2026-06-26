import { EventEmitter } from "node:events";

import type { Client, ConnectConfig } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteHost, RemoteHostConnectionStatus } from "../../../src/hosts/host-types";
import { RemoteHostConnection } from "../../../src/hosts/ssh-connection-manager";

function createHost(overrides: Partial<RemoteHost> = {}): RemoteHost {
	return {
		id: "van-one",
		label: "Van One",
		ssh: { hostname: "10.0.0.5", port: 22, username: "agent" },
		runtimePort: 3484,
		createdAt: Date.now(),
		...overrides,
	};
}

/** Minimal stand-in for an ssh2 Client that lets tests drive the lifecycle. */
class FakeClient extends EventEmitter {
	connectConfig: ConnectConfig | null = null;
	ended = false;

	connect(config: ConnectConfig): this {
		this.connectConfig = config;
		return this;
	}

	end(): this {
		this.ended = true;
		return this;
	}

	emitReady(): void {
		this.emit("ready");
	}

	emitError(message: string): void {
		this.emit("error", new Error(message));
	}
}

function asClient(fake: FakeClient): Client {
	return fake as unknown as Client;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition.");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

let clients: FakeClient[];

beforeEach(() => {
	clients = [];
});

afterEach(() => {
	vi.useRealTimers();
});

function makeConnection(host = createHost(), options = {}): RemoteHostConnection {
	return new RemoteHostConnection(host, {
		sshClientFactory: () => {
			const client = new FakeClient();
			clients.push(client);
			return asClient(client);
		},
		...options,
	});
}

describe("RemoteHostConnection", () => {
	it("transitions to connected with a loopback forward port when the client is ready", async () => {
		const statuses: RemoteHostConnectionStatus[] = [];
		const connection = makeConnection();
		connection.onStatusChange((status) => statuses.push(status));

		connection.connect();
		expect(connection.getStatus().state).toBe("connecting");
		expect(clients).toHaveLength(1);

		clients[0]?.emitReady();
		await waitFor(() => connection.getStatus().state === "connected");

		const status = connection.getStatus();
		expect(status.localPort).toBeGreaterThan(0);
		expect(status.error).toBeNull();
		expect(statuses.map((entry) => entry.state)).toContain("connected");

		connection.disconnect();
		expect(connection.getStatus().state).toBe("disconnected");
		expect(connection.getStatus().localPort).toBeNull();
		expect(clients[0]?.ended).toBe(true);
	});

	it("passes auth material from the host config into connect()", () => {
		const connection = makeConnection(
			createHost({ ssh: { hostname: "h", port: 2222, username: "u", useAgent: true } }),
		);
		process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
		try {
			connection.connect();
			expect(clients[0]?.connectConfig).toMatchObject({
				host: "h",
				port: 2222,
				username: "u",
				agent: "/tmp/agent.sock",
			});
		} finally {
			delete process.env.SSH_AUTH_SOCK;
			connection.disconnect();
		}
	});

	it("enters the error state and schedules a reconnect after a failure", async () => {
		vi.useFakeTimers();
		const connection = makeConnection(createHost(), {
			reconnectBaseDelayMs: 1000,
			reconnectMaxDelayMs: 1000,
		});

		connection.connect();
		clients[0]?.emitError("connection refused");
		expect(connection.getStatus().state).toBe("error");
		expect(connection.getStatus().error).toContain("connection refused");
		expect(clients).toHaveLength(1);

		// Backoff timer should spin up a fresh client on the next attempt.
		vi.advanceTimersByTime(1000);
		expect(clients).toHaveLength(2);
		expect(connection.getStatus().state).toBe("connecting");

		connection.disconnect();
	});

	it("cancels a pending reconnect when disconnected", () => {
		vi.useFakeTimers();
		const connection = makeConnection(createHost(), { reconnectBaseDelayMs: 1000 });

		connection.connect();
		clients[0]?.emitError("connection refused");
		expect(connection.getStatus().state).toBe("error");

		// Disconnecting before the backoff timer fires must cancel the reconnect.
		connection.disconnect();
		vi.advanceTimersByTime(10_000);
		expect(clients).toHaveLength(1);
		expect(connection.getStatus().state).toBe("disconnected");
	});
});
