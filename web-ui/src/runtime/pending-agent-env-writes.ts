// Coordinates hub-central env writes made from the task-create flow, which
// persist a task's env *after* the task id exists. Two hazards are handled here:
//
//  1. Lost updates — each write is a read-modify-write of the shared hub config,
//     so concurrent writes (e.g. rapid "create more") could clobber one another.
//     Writes are serialized through a single promise chain.
//  2. A start-on-create race — `resolveLaunchAgentEnv` re-reads the hub config at
//     launch, which can run before a freshly-created task's env write lands. The
//     launch path awaits `whenTaskEnvWriteSettled` first so "Create & start"
//     always sees the env that was set in the create dialog.
import type { AgentEnvMap } from "@runtime-agent-env";

import { fetchAgentEnvConfig, saveAgentEnvConfig } from "@/runtime/agent-env-query";

let writeChain: Promise<unknown> = Promise.resolve();
const pendingByTask = new Map<string, Promise<void>>();

/**
 * Persist a task's env into the hub-central config, queued behind any in-flight
 * env write so concurrent read-modify-write cycles can't clobber each other.
 * Returns a promise that resolves once this task's write lands (rejects if it
 * fails, so callers can surface an error).
 */
export function queueTaskEnvWrite(taskId: string, env: AgentEnvMap): Promise<void> {
	const run = writeChain
		// Isolate prior failures so one bad write doesn't stall the queue.
		.catch(() => undefined)
		.then(async () => {
			const config = await fetchAgentEnvConfig();
			const tasks = { ...config.tasks };
			if (Object.keys(env).length > 0) {
				tasks[taskId] = env;
			} else {
				delete tasks[taskId];
			}
			await saveAgentEnvConfig({ global: config.global, projects: config.projects, tasks });
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

/** Resolves once any pending env write for the task has settled (success or failure). */
export async function whenTaskEnvWriteSettled(taskId: string): Promise<void> {
	const pending = pendingByTask.get(taskId);
	if (pending) {
		await pending.catch(() => undefined);
	}
}
