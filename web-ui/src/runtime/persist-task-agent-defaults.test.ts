import { describe, expect, it, vi } from "vitest";

import { persistTaskAgentDefaultsIfChanged } from "@/runtime/persist-task-agent-defaults";
import type { RuntimeConfigResponse } from "@/runtime/types";

const saveRuntimeConfigMock = vi.hoisted(() => vi.fn());
const saveClineProviderSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	saveRuntimeConfig: saveRuntimeConfigMock,
	saveClineProviderSettings: saveClineProviderSettingsMock,
}));

function createRuntimeConfig(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: "claude",
		globalConfigPath: "/tmp/.cline/kanban/config.json",
		projectConfigPath: null,
		readyForReviewNotificationsEnabled: true,
		detectedCommands: [],
		agents: [],
		shortcuts: [],
		clineProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			baseUrl: null,
			reasoningEffort: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
		cliAgentModelDefaults: {},
		...overrides,
	};
}

describe("persistTaskAgentDefaultsIfChanged", () => {
	it("does nothing when runtimeConfig is unavailable", async () => {
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: null,
			agentId: "codex",
			cliModel: "gpt-5.5",
			clineSettings: undefined,
		});
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
		expect(saveClineProviderSettingsMock).not.toHaveBeenCalled();
	});

	it("does nothing when the task used only defaults (no explicit overrides)", async () => {
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig(),
			agentId: undefined,
			cliModel: undefined,
			clineSettings: undefined,
		});
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
		expect(saveClineProviderSettingsMock).not.toHaveBeenCalled();
	});

	it("persists a new selected agent when the task overrides it", async () => {
		saveRuntimeConfigMock.mockClear();
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig({ selectedAgentId: "claude" }),
			agentId: "codex",
			cliModel: undefined,
			clineSettings: undefined,
		});
		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("workspace-1", { selectedAgentId: "codex" });
	});

	it("does not resave the selected agent when it matches the current default", async () => {
		saveRuntimeConfigMock.mockClear();
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig({ selectedAgentId: "codex" }),
			agentId: "codex",
			cliModel: undefined,
			clineSettings: undefined,
		});
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
	});

	it("persists a new cliModel default for the effective (non-cline) agent", async () => {
		saveRuntimeConfigMock.mockClear();
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig({ selectedAgentId: "codex", cliAgentModelDefaults: { codex: "gpt-5.2" } }),
			agentId: undefined,
			cliModel: "gpt-5.5",
			clineSettings: undefined,
		});
		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("workspace-1", {
			cliAgentModelDefaults: { codex: "gpt-5.5" },
		});
	});

	it("merges a new agent's cliModel default without dropping other agents' defaults", async () => {
		saveRuntimeConfigMock.mockClear();
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig({ selectedAgentId: "claude", cliAgentModelDefaults: { claude: "sonnet" } }),
			agentId: "codex",
			cliModel: "gpt-5.5",
			clineSettings: undefined,
		});
		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("workspace-1", {
			selectedAgentId: "codex",
			cliAgentModelDefaults: { claude: "sonnet", codex: "gpt-5.5" },
		});
	});

	it("never persists a cliModel default for cline", async () => {
		saveRuntimeConfigMock.mockClear();
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig({ selectedAgentId: "cline" }),
			agentId: undefined,
			cliModel: "should-not-be-used",
			clineSettings: undefined,
		});
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
	});

	it("persists cline provider/model overrides using the current provider as fallback", async () => {
		saveClineProviderSettingsMock.mockClear();
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig({ selectedAgentId: "cline" }),
			agentId: undefined,
			cliModel: undefined,
			clineSettings: { modelId: "claude-opus-4-8" },
		});
		expect(saveClineProviderSettingsMock).toHaveBeenCalledWith("workspace-1", {
			providerId: "anthropic",
			modelId: "claude-opus-4-8",
		});
	});

	it("does not resave cline settings that already match the current default", async () => {
		saveClineProviderSettingsMock.mockClear();
		await persistTaskAgentDefaultsIfChanged({
			workspaceId: "workspace-1",
			runtimeConfig: createRuntimeConfig({ selectedAgentId: "cline" }),
			agentId: undefined,
			cliModel: undefined,
			clineSettings: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
		});
		expect(saveClineProviderSettingsMock).not.toHaveBeenCalled();
	});
});
