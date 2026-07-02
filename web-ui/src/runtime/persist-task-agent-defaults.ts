import { saveClineProviderSettings, saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeTaskClineSettings } from "@/runtime/types";

export interface PersistTaskAgentDefaultsInput {
	workspaceId: string | null;
	runtimeConfig: RuntimeConfigResponse | null;
	agentId: RuntimeAgentId | undefined;
	cliModel: string | undefined;
	clineSettings: RuntimeTaskClineSettings | undefined;
}

/**
 * When a task is created with an explicit agent/model override, remember that choice as the
 * default for the next task — mirrors how Claude Code's and Codex's own CLIs already persist
 * the last model picked in their interactive pickers as their new default. Best-effort: a
 * failed default update should never block or surface an error for task creation.
 */
export async function persistTaskAgentDefaultsIfChanged(input: PersistTaskAgentDefaultsInput): Promise<void> {
	const { workspaceId, runtimeConfig, agentId, cliModel, clineSettings } = input;
	if (!runtimeConfig) {
		return;
	}
	const effectiveAgentId = agentId ?? runtimeConfig.selectedAgentId;

	const runtimeConfigUpdates: {
		selectedAgentId?: RuntimeAgentId;
		cliAgentModelDefaults?: Partial<Record<RuntimeAgentId, string>>;
	} = {};
	if (agentId !== undefined && agentId !== runtimeConfig.selectedAgentId) {
		runtimeConfigUpdates.selectedAgentId = agentId;
	}
	if (
		effectiveAgentId !== "cline" &&
		cliModel !== undefined &&
		cliModel !== runtimeConfig.cliAgentModelDefaults[effectiveAgentId]
	) {
		runtimeConfigUpdates.cliAgentModelDefaults = {
			...runtimeConfig.cliAgentModelDefaults,
			[effectiveAgentId]: cliModel,
		};
	}
	if (Object.keys(runtimeConfigUpdates).length > 0) {
		try {
			await saveRuntimeConfig(workspaceId, runtimeConfigUpdates);
		} catch {
			// Best-effort — see doc comment above.
		}
	}

	if (effectiveAgentId !== "cline" || !clineSettings) {
		return;
	}
	const currentProviderId =
		runtimeConfig.clineProviderSettings?.providerId ?? runtimeConfig.clineProviderSettings?.oauthProvider ?? null;
	const nextProviderId = clineSettings.providerId ?? currentProviderId;
	if (!nextProviderId) {
		return;
	}
	const changed =
		(clineSettings.providerId !== undefined && clineSettings.providerId !== currentProviderId) ||
		(clineSettings.modelId !== undefined && clineSettings.modelId !== runtimeConfig.clineProviderSettings?.modelId) ||
		(clineSettings.reasoningEffort !== undefined &&
			clineSettings.reasoningEffort !== runtimeConfig.clineProviderSettings?.reasoningEffort);
	if (!changed) {
		return;
	}
	try {
		await saveClineProviderSettings(workspaceId, {
			providerId: nextProviderId,
			...(clineSettings.modelId !== undefined ? { modelId: clineSettings.modelId } : {}),
			...(clineSettings.reasoningEffort !== undefined ? { reasoningEffort: clineSettings.reasoningEffort } : {}),
		});
	} catch {
		// Best-effort — see doc comment above.
	}
}
