import { LOCAL_HOST_ID, resolveHostIdForTarget } from "@/runtime/active-host";

/**
 * Maps a task id to the host its *execution* runs on, derived from the card's
 * `runtimeTarget`. The board is hub-owned, but a task's agent/worktree/terminal
 * may live on a remote SSH host — so per-task execution ops (start/stop/input,
 * chat, terminal + state streams) must route to that host via `x-kanban-host-id`.
 *
 * Only non-local hosts are stored; anything absent resolves to the hub, which is
 * the correct default across reloads before the board has re-synced.
 */
const hostByTaskId = new Map<string, string>();

/** Record (or clear) the host a task routes to, from its `runtimeTarget`. */
export function setTaskHost(taskId: string, runtimeTarget: string | undefined | null): void {
	const hostId = resolveHostIdForTarget(runtimeTarget);
	if (hostId === LOCAL_HOST_ID) {
		hostByTaskId.delete(taskId);
	} else {
		hostByTaskId.set(taskId, hostId);
	}
}

/** The host id a task's execution routes to; `LOCAL_HOST_ID` (the hub) when unknown. */
export function getTaskHostId(taskId: string): string {
	return hostByTaskId.get(taskId) ?? LOCAL_HOST_ID;
}

/**
 * Reconcile the registry with the current board so every op — including ones that
 * only carry a taskId — resolves the right host after a reload. Tasks absent from
 * the board are dropped.
 */
export function syncTaskHosts(cards: Iterable<{ id: string; runtimeTarget?: string }>): void {
	const seen = new Set<string>();
	for (const card of cards) {
		seen.add(card.id);
		setTaskHost(card.id, card.runtimeTarget);
	}
	for (const taskId of [...hostByTaskId.keys()]) {
		if (!seen.has(taskId)) {
			hostByTaskId.delete(taskId);
		}
	}
}
