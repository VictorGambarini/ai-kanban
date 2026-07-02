import { describe, expect, it, vi } from "vitest";

import type { RuntimeClaudeStatuslineConfig } from "../../../src/core/api-contract";
import { createClaudeStatuslineApi } from "../../../src/trpc/claude-statusline-api";

function createConfig(overrides: Partial<RuntimeClaudeStatuslineConfig> = {}): RuntimeClaudeStatuslineConfig {
	return {
		scriptPath: "/home/user/.claude/statusline.py",
		settingsPath: "/home/user/.claude/settings.json",
		scriptContent: "",
		enabled: false,
		settingsParseError: null,
		...overrides,
	};
}

describe("createClaudeStatuslineApi", () => {
	it("delegates load to the injected loadConfig dependency", async () => {
		const config = createConfig({ enabled: true, scriptContent: "print('hi')" });
		const loadConfig = vi.fn(async () => config);
		const api = createClaudeStatuslineApi({ loadConfig });

		const result = await api.load();

		expect(result).toEqual(config);
		expect(loadConfig).toHaveBeenCalledTimes(1);
	});

	it("delegates save to the injected saveConfig dependency with the given input", async () => {
		const config = createConfig({ enabled: true, scriptContent: "print('hi')" });
		const saveConfig = vi.fn(async () => config);
		const api = createClaudeStatuslineApi({ saveConfig });

		const result = await api.save({ scriptContent: "print('hi')", enabled: true });

		expect(result).toEqual(config);
		expect(saveConfig).toHaveBeenCalledWith({ scriptContent: "print('hi')", enabled: true });
	});
});
