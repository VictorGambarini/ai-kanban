// Resolves the effective custom env for a task launch from the hub-central
// config. Kept separate from the start mutation so both the board and the home
// agent start paths share one source of truth, and so it can be unit-tested.
//
// The config is fetched fresh at launch (a cheap hub-local query) so edits made
// in Settings or on the card take effect on the very next run, and the resolved
// map is shipped in the request body — making it identical for local and remote
// tasks. Resolution failures never block a launch; the task just starts without
// custom env.
import { type AgentEnvMap, resolveEffectiveAgentEnv } from "@runtime-agent-env";

import { whenTaskEnvWriteSettled } from "@/runtime/pending-agent-env-writes";
import { fetchAgentEnvConfig } from "@/runtime/runtime-config-query";

export async function resolveLaunchAgentEnv(scope: {
	projectId?: string | null;
	taskId?: string | null;
}): Promise<AgentEnvMap | undefined> {
	try {
		// A task created with env in the create dialog persists it asynchronously;
		// wait for that write before reading so "Create & start" sees it.
		if (scope.taskId) {
			await whenTaskEnvWriteSettled(scope.taskId);
		}
		const config = await fetchAgentEnvConfig();
		const resolved = resolveEffectiveAgentEnv(config, scope);
		return Object.keys(resolved).length > 0 ? resolved : undefined;
	} catch (error) {
		console.warn("[kanban] Failed to resolve custom agent env for launch; starting without it.", error);
		return undefined;
	}
}
