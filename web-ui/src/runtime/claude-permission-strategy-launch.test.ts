import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLaunchClaudePermissionStrategy } from "@/runtime/claude-permission-strategy-launch";
import { fetchClaudePermissionStrategyConfig } from "@/runtime/claude-permission-strategy-query";

vi.mock("@/runtime/claude-permission-strategy-query", () => ({
	fetchClaudePermissionStrategyConfig: vi.fn(),
}));

const fetchMock = vi.mocked(fetchClaudePermissionStrategyConfig);

afterEach(() => {
	vi.clearAllMocks();
});

describe("resolveLaunchClaudePermissionStrategy", () => {
	it("resolves the most specific scope", async () => {
		fetchMock.mockResolvedValue({
			global: "auto",
			projects: { "proj-a": "bypass" },
			tasks: { "task-1": "auto" },
		});
		expect(await resolveLaunchClaudePermissionStrategy({ projectId: "proj-a", taskId: "task-1" })).toBe("auto");
	});

	it("falls back to the default when nothing is set", async () => {
		fetchMock.mockResolvedValue({ global: null, projects: {}, tasks: {} });
		expect(await resolveLaunchClaudePermissionStrategy({ projectId: "x", taskId: "y" })).toBe("bypass");
	});

	it("never throws when the config fetch fails", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));
		expect(await resolveLaunchClaudePermissionStrategy({ projectId: "p", taskId: "t" })).toBeUndefined();
	});
});
