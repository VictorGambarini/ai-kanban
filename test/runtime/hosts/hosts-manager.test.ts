import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client, ConnectConfig } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostsManager } from "../../../src/hosts/hosts-manager";
import { RemoteHostConnectionManager } from "../../../src/hosts/ssh-connection-manager";
import { createHostsApi } from "../../../src/trpc/hosts-api";

class FakeClient extends EventEmitter {
	connect(_config: ConnectConfig): this {
		// Never emit "ready", so connections stay in the "connecting" state —
		// enough to exercise registry + status plumbing without real SSH.
		return this;
	}
	end(): this {
		return this;
	}
}

let tempHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-hosts-mgr-"));
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
});

afterEach(() => {
	if (previousHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome;
	}
	if (previousUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = previousUserProfile;
	}
	rmSync(tempHome, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
});

function makeManager(): HostsManager {
	const connectionManager = new RemoteHostConnectionManager({
		sshClientFactory: () => new FakeClient() as unknown as Client,
	});
	return new HostsManager({ connectionManager, autoBootstrap: false });
}

describe("HostsManager + hosts API", () => {
	it("registers a host, starts connecting it, and reports it in summaries", async () => {
		const manager = makeManager();
		const api = createHostsApi({ hostsManager: manager });

		const added = await api.add({ label: "Van One", ssh: { hostname: "10.0.0.5", username: "agent" } });
		expect(added.host.label).toBe("Van One");
		expect(added.status?.state).toBe("connecting");

		const listed = await api.list();
		expect(listed.hosts).toHaveLength(1);
		expect(listed.hosts[0]?.host.id).toBe(added.host.id);
		expect(listed.hosts[0]?.status?.state).toBe("connecting");
		// No bootstrap has run yet, so no runtime error or version is known.
		expect(listed.hosts[0]?.runtimeError).toBeNull();
		expect(listed.hosts[0]?.runtimeVersion).toBeNull();

		// Not connected yet, so there is no forwarded port to proxy to.
		expect(manager.getForwardedPort(added.host.id)).toBeNull();

		manager.disconnectAll();
	});

	it("removes a host and its connection", async () => {
		const manager = makeManager();
		const api = createHostsApi({ hostsManager: manager });
		const added = await api.add({ label: "Van", ssh: { hostname: "a", username: "u" } });

		expect((await api.remove({ hostId: added.host.id })).ok).toBe(true);
		expect((await api.list()).hosts).toHaveLength(0);
		expect(manager.getStatus(added.host.id)).toBeNull();
	});

	it("restart returns null for an unknown host", async () => {
		const manager = makeManager();
		const api = createHostsApi({ hostsManager: manager });
		expect(await api.restart({ hostId: "nope" })).toBeNull();
	});

	it("restart re-runs the connection for a known host", async () => {
		const manager = makeManager();
		const api = createHostsApi({ hostsManager: manager });
		const added = await api.add({ label: "Van", ssh: { hostname: "a", username: "u" } });

		// Not connected (FakeClient never readies), so there is no runtime to stop;
		// restart still kicks off a fresh connection rather than throwing.
		const status = await api.restart({ hostId: added.host.id });
		expect(status?.state).toBe("connecting");
		manager.disconnectAll();
	});

	it("connects hosts discovered at startup", async () => {
		// Seed the registry, then start a fresh manager.
		const seeding = makeManager();
		const seeded = await seeding.registerHost({ label: "Van", ssh: { hostname: "a", username: "u" } });
		seeding.disconnectAll();

		const manager = makeManager();
		await manager.start();
		expect(manager.getStatus(seeded.id)?.state).toBe("connecting");
		manager.disconnectAll();
	});
});
