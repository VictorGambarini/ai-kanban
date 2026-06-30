// Transport for the hub-central agent env config.
//
// Agent env is hub-central: it must ALWAYS read/write via the hub client, never
// the active-host client, so the same config backs local and remote tasks (the
// effective set is resolved on the hub and shipped in the task-start request).
// This module imports ONLY the hub client — that is the enforcement. Keeping these
// two functions out of runtime-config-query.ts (which is active-host scoped) means
// a new query can't accidentally read another machine's env config; the wrong
// client is unreachable from here.
import { getHubTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentEnvConfigResponse, RuntimeAgentEnvSaveRequest } from "@/runtime/types";

export async function fetchAgentEnvConfig(): Promise<RuntimeAgentEnvConfigResponse> {
	return await getHubTrpcClient().runtime.getAgentEnv.query();
}

export async function saveAgentEnvConfig(config: RuntimeAgentEnvSaveRequest): Promise<RuntimeAgentEnvConfigResponse> {
	return await getHubTrpcClient().runtime.saveAgentEnv.mutate(config);
}
