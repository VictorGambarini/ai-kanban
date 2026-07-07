// Transport for the hub-central Claude Code permission strategy config.
//
// Same hub-only enforcement as agent-env-query.ts: this config must always
// read/write via the hub client, never the active-host client, so the same
// choice backs local and remote tasks (the effective value is resolved on the
// hub and shipped in the task-start request). Importing only the hub client
// here is the enforcement — the wrong client is unreachable from this module.
import { getHubTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeClaudePermissionStrategyConfigResponse,
	RuntimeClaudePermissionStrategySaveRequest,
} from "@/runtime/types";

export async function fetchClaudePermissionStrategyConfig(): Promise<RuntimeClaudePermissionStrategyConfigResponse> {
	return await getHubTrpcClient().runtime.getClaudePermissionStrategy.query();
}

export async function saveClaudePermissionStrategyConfig(
	config: RuntimeClaudePermissionStrategySaveRequest,
): Promise<RuntimeClaudePermissionStrategyConfigResponse> {
	return await getHubTrpcClient().runtime.saveClaudePermissionStrategy.mutate(config);
}
