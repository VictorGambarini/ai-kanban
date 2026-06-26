import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getRemoteHost,
	listRemoteHosts,
	registerRemoteHost,
	removeRemoteHost,
	updateRemoteHost,
} from "../../../src/hosts/host-registry";

let tempHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-hosts-"));
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

describe("host-registry", () => {
	it("returns an empty list before any host is registered", async () => {
		await expect(listRemoteHosts()).resolves.toEqual([]);
	});

	it("registers a host with generated id and defaults", async () => {
		const host = await registerRemoteHost({
			label: "Van One",
			ssh: { hostname: "10.0.0.5", username: "agent" },
		});
		expect(host.id).toBe("van-one");
		expect(host.ssh.port).toBe(22);
		expect(host.runtimePort).toBe(3484);
		expect(host.createdAt).toBeGreaterThan(0);

		const fetched = await getRemoteHost(host.id);
		expect(fetched).toEqual(host);
	});

	it("generates a unique id when labels collide", async () => {
		const first = await registerRemoteHost({ label: "Van", ssh: { hostname: "a", username: "u" } });
		const second = await registerRemoteHost({ label: "Van", ssh: { hostname: "b", username: "u" } });
		expect(first.id).toBe("van");
		expect(second.id).not.toBe("van");
		expect(second.id.startsWith("van-")).toBe(true);

		const hosts = await listRemoteHosts();
		expect(hosts).toHaveLength(2);
	});

	it("persists optional ssh fields but never a passphrase value", async () => {
		const host = await registerRemoteHost({
			label: "Secure Van",
			ssh: {
				hostname: "secure.local",
				port: 2222,
				username: "agent",
				privateKeyPath: "/home/agent/.ssh/id_ed25519",
				useAgent: true,
				passphraseEnv: "VAN_KEY_PASSPHRASE",
			},
			runtimePort: 4000,
		});
		expect(host.ssh.port).toBe(2222);
		expect(host.ssh.privateKeyPath).toBe("/home/agent/.ssh/id_ed25519");
		expect(host.ssh.useAgent).toBe(true);
		expect(host.ssh.passphraseEnv).toBe("VAN_KEY_PASSPHRASE");
		expect(host.runtimePort).toBe(4000);
		// The serialized record must not contain a literal passphrase field.
		expect(JSON.stringify(host)).not.toContain('passphrase":');
	});

	it("updates an existing host and leaves id/createdAt immutable", async () => {
		const host = await registerRemoteHost({ label: "Van", ssh: { hostname: "a", username: "u" } });
		const updated = await updateRemoteHost(host.id, {
			label: "Renamed Van",
			ssh: { hostname: "b.local" },
			runtimePort: 5000,
		});
		expect(updated).not.toBeNull();
		expect(updated?.id).toBe(host.id);
		expect(updated?.createdAt).toBe(host.createdAt);
		expect(updated?.label).toBe("Renamed Van");
		expect(updated?.ssh.hostname).toBe("b.local");
		expect(updated?.ssh.username).toBe("u");
		expect(updated?.runtimePort).toBe(5000);
	});

	it("returns null when updating a missing host", async () => {
		await expect(updateRemoteHost("nope", { label: "x" })).resolves.toBeNull();
	});

	it("removes a host and reports whether it existed", async () => {
		const host = await registerRemoteHost({ label: "Van", ssh: { hostname: "a", username: "u" } });
		await expect(removeRemoteHost(host.id)).resolves.toBe(true);
		await expect(removeRemoteHost(host.id)).resolves.toBe(false);
		await expect(listRemoteHosts()).resolves.toEqual([]);
	});
});
