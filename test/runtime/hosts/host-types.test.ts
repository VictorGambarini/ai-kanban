import { describe, expect, it } from "vitest";

import {
	createReverseHostToken,
	hashReverseHostToken,
	isReverseHost,
	isSshRemoteHost,
	type RemoteHost,
	remoteHostSchema,
} from "../../../src/hosts/host-types";

describe("host-types transport", () => {
	it("defaults legacy records (no transport) to ssh", () => {
		const parsed = remoteHostSchema.parse({
			id: "van-one",
			label: "Van One",
			ssh: { hostname: "10.0.0.5", port: 22, username: "agent" },
			runtimePort: 3484,
			createdAt: 1,
		});
		expect(parsed.transport).toBe("ssh");
	});

	it("parses a reverse host with a token hash and no ssh", () => {
		const parsed = remoteHostSchema.parse({
			id: "laptop",
			label: "Laptop",
			transport: "reverse",
			runtimePort: 3484,
			reverse: { tokenHash: "abc123" },
			createdAt: 1,
		});
		expect(parsed.transport).toBe("reverse");
		expect(parsed.ssh).toBeUndefined();
		expect(parsed.reverse?.tokenHash).toBe("abc123");
	});

	it("narrows hosts by transport", () => {
		const ssh: RemoteHost = {
			id: "a",
			label: "A",
			transport: "ssh",
			ssh: { hostname: "h", port: 22, username: "u" },
			runtimePort: 3484,
			createdAt: 1,
		};
		const reverse: RemoteHost = {
			id: "b",
			label: "B",
			transport: "reverse",
			runtimePort: 3484,
			reverse: { tokenHash: "x" },
			createdAt: 1,
		};
		expect(isSshRemoteHost(ssh)).toBe(true);
		expect(isReverseHost(ssh)).toBe(false);
		expect(isSshRemoteHost(reverse)).toBe(false);
		expect(isReverseHost(reverse)).toBe(true);
	});

	it("generates a token whose hash matches and is stable", () => {
		const { token, tokenHash } = createReverseHostToken();
		expect(token).toBeTruthy();
		expect(tokenHash).toBe(hashReverseHostToken(token));
		// Different tokens hash differently.
		expect(createReverseHostToken().tokenHash).not.toBe(tokenHash);
	});
});
