// Resolves the effective Claude Code permission strategy for a task launch
// from the hub-central config. Kept separate from the start mutation so both
// the board and the home agent start paths share one source of truth, and so
// it can be unit-tested. Mirrors agent-env-launch.ts.
//
// The config is fetched fresh at launch (a cheap hub-local query) so edits
// made in Settings or on the card take effect on the very next run. Resolution
// failures never block a launch; the task just starts with the default
// strategy (bypass).
import {
	type ClaudePermissionStrategy,
	resolveEffectiveClaudePermissionStrategy,
} from "@runtime-claude-permission-strategy";
import { fetchClaudePermissionStrategyConfig } from "@/runtime/claude-permission-strategy-query";
import { whenTaskClaudePermissionStrategyWriteSettled } from "@/runtime/pending-claude-permission-strategy-writes";

export async function resolveLaunchClaudePermissionStrategy(scope: {
	projectId?: string | null;
	taskId?: string | null;
}): Promise<ClaudePermissionStrategy | undefined> {
	try {
		// A task created with an override in the create dialog persists it
		// asynchronously; wait for that write before reading so "Create & start"
		// sees it.
		if (scope.taskId) {
			await whenTaskClaudePermissionStrategyWriteSettled(scope.taskId);
		}
		const config = await fetchClaudePermissionStrategyConfig();
		return resolveEffectiveClaudePermissionStrategy(config, scope);
	} catch (error) {
		console.warn("[kanban] Failed to resolve Claude Code permission strategy for launch; using the default.", error);
		return undefined;
	}
}
