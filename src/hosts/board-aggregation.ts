import type {
	RuntimeBoardColumn,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { LOCAL_HOST_ID } from "./host-proxy";

/**
 * Separator between a host id and an original task id in a namespaced id. Chosen
 * to be vanishingly unlikely in real task ids while staying URL/JSON safe.
 */
export const HOST_NAMESPACE_SEPARATOR = "::";

const CANONICAL_COLUMNS: ReadonlyArray<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "trash", title: "Done" },
];

/** Encode `{hostId, taskId}` into a single board-wide id. Local ids are left untouched. */
export function namespaceTaskId(hostId: string, taskId: string): string {
	if (hostId === LOCAL_HOST_ID) {
		return taskId;
	}
	return `${hostId}${HOST_NAMESPACE_SEPARATOR}${taskId}`;
}

/**
 * Decode a namespaced id back to `{hostId, taskId}`. Ids without a separator are
 * treated as belonging to the local host.
 */
export function parseNamespacedTaskId(value: string): { hostId: string; taskId: string } {
	const index = value.indexOf(HOST_NAMESPACE_SEPARATOR);
	if (index === -1) {
		return { hostId: LOCAL_HOST_ID, taskId: value };
	}
	return {
		hostId: value.slice(0, index),
		taskId: value.slice(index + HOST_NAMESPACE_SEPARATOR.length),
	};
}

export interface HostBoardContribution {
	hostId: string;
	board: RuntimeBoardData;
}

export interface HostSessionsContribution {
	hostId: string;
	sessions: Record<string, RuntimeTaskSessionSummary>;
}

function namespaceDependency(hostId: string, dependency: RuntimeBoardDependency): RuntimeBoardDependency {
	return {
		...dependency,
		id: namespaceTaskId(hostId, dependency.id),
		fromTaskId: namespaceTaskId(hostId, dependency.fromTaskId),
		toTaskId: namespaceTaskId(hostId, dependency.toTaskId),
	};
}

/**
 * Merge per-host boards into a single board. Cards keep all their fields but get
 * host-namespaced ids (and so do dependencies), so the UI can render one board
 * and route each card's actions back to the host that owns it.
 */
export function mergeBoards(contributions: readonly HostBoardContribution[]): RuntimeBoardData {
	const columnsById = new Map<RuntimeBoardColumnId, RuntimeBoardColumn>(
		CANONICAL_COLUMNS.map((column) => [column.id, { id: column.id, title: column.title, cards: [] }]),
	);
	const dependencies: RuntimeBoardDependency[] = [];

	for (const { hostId, board } of contributions) {
		for (const column of board.columns) {
			const target = columnsById.get(column.id);
			if (!target) {
				continue;
			}
			for (const card of column.cards) {
				target.cards.push({ ...card, id: namespaceTaskId(hostId, card.id) });
			}
		}
		for (const dependency of board.dependencies) {
			dependencies.push(namespaceDependency(hostId, dependency));
		}
	}

	return {
		columns: CANONICAL_COLUMNS.map((column) => columnsById.get(column.id)).filter(
			(column): column is RuntimeBoardColumn => column !== undefined,
		),
		dependencies,
	};
}

/** Merge per-host session records, namespacing both the keys and each summary's taskId. */
export function mergeSessions(
	contributions: readonly HostSessionsContribution[],
): Record<string, RuntimeTaskSessionSummary> {
	const merged: Record<string, RuntimeTaskSessionSummary> = {};
	for (const { hostId, sessions } of contributions) {
		for (const [taskId, summary] of Object.entries(sessions)) {
			const namespacedId = namespaceTaskId(hostId, taskId);
			merged[namespacedId] = { ...summary, taskId: namespacedId };
		}
	}
	return merged;
}
