import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLaunchAgentEnv } from "@/runtime/agent-env-launch";
import { fetchAgentEnvConfig } from "@/runtime/agent-env-query";

vi.mock("@/runtime/agent-env-query", () => ({
	fetchAgentEnvConfig: vi.fn(),
}));

const fetchMock = vi.mocked(fetchAgentEnvConfig);

afterEach(() => {
	vi.clearAllMocks();
});

describe("resolveLaunchAgentEnv", () => {
	it("layers global, project, and task scopes", async () => {
		fetchMock.mockResolvedValue({
			global: { SHARED: "g", G: "1" },
			projects: { "proj-a": { SHARED: "p", P: "2" } },
			tasks: { "task-1": { SHARED: "t", T: "3" } },
		});
		const env = await resolveLaunchAgentEnv({ projectId: "proj-a", taskId: "task-1" });
		expect(env).toEqual({ SHARED: "t", G: "1", P: "2", T: "3" });
	});

	it("returns undefined when nothing resolves", async () => {
		fetchMock.mockResolvedValue({ global: {}, projects: {}, tasks: {} });
		expect(await resolveLaunchAgentEnv({ projectId: "x", taskId: "y" })).toBeUndefined();
	});

	it("never throws when the config fetch fails", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));
		expect(await resolveLaunchAgentEnv({ projectId: "p", taskId: "t" })).toBeUndefined();
	});
});
