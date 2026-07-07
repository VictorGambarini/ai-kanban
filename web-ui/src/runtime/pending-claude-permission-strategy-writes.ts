// Coordinates hub-central Claude permission strategy writes made from the
// task-create flow, which persist a task's override *after* the task id
// exists. Mirrors pending-agent-env-writes.ts's two hazards and fixes:
//
//  1. Lost updates — each write is a read-modify-write of the shared hub
//     config, so concurrent writes could clobber one another. Writes are
//     serialized through a single promise chain.
//  2. A start-on-create race — `resolveLaunchClaudePermissionStrategy` re-reads
//     the hub config at launch, which can run before a freshly-created task's
//     write lands. The launch path awaits `whenTaskClaudePermissionStrategyWriteSettled`
//     first so "Create & start" always sees the override set in the create dialog.
import type { ClaudePermissionStrategy } from "@runtime-claude-permission-strategy";

import {
	fetchClaudePermissionStrategyConfig,
	saveClaudePermissionStrategyConfig,
} from "@/runtime/claude-permission-strategy-query";

let writeChain: Promise<unknown> = Promise.resolve();
const pendingByTask = new Map<string, Promise<void>>();

/**
 * Persist a task's Claude permission strategy override into the hub-central
 * config, queued behind any in-flight write so concurrent read-modify-write
 * cycles can't clobber each other. Pass `null` to clear the task override.
 * Returns a promise that resolves once this task's write lands (rejects if it
 * fails, so callers can surface an error).
 */
export function queueTaskClaudePermissionStrategyWrite(
	taskId: string,
	strategy: ClaudePermissionStrategy | null,
): Promise<void> {
	const run = writeChain
		// Isolate prior failures so one bad write doesn't stall the queue.
		.catch(() => undefined)
		.then(async () => {
			const config = await fetchClaudePermissionStrategyConfig();
			const tasks = { ...config.tasks };
			if (strategy) {
				tasks[taskId] = strategy;
			} else {
				delete tasks[taskId];
			}
			await saveClaudePermissionStrategyConfig({ global: config.global, projects: config.projects, tasks });
		});
	writeChain = run;
	const tracked = run.finally(() => {
		if (pendingByTask.get(taskId) === tracked) {
			pendingByTask.delete(taskId);
		}
	});
	pendingByTask.set(taskId, tracked);
	return tracked;
}

/** Resolves once any pending permission-strategy write for the task has settled (success or failure). */
export async function whenTaskClaudePermissionStrategyWriteSettled(taskId: string): Promise<void> {
	const pending = pendingByTask.get(taskId);
	if (pending) {
		await pending.catch(() => undefined);
	}
}
