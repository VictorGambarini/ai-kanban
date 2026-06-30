// Pure decider for the session -> board column reconciliation.
//
// When a task's agent session changes state, its card may need to move columns:
//   - awaiting_review (while in `in_progress`) -> review
//   - running (while in `review`)              -> in_progress
//   - interrupted (while in an active column)  -> trash
//
// The rules — and especially the guards that prevent data loss — used to live
// inline in a board-mutation effect, tangled with imperative move helpers and
// programmatic-move/animation state, so they could only be exercised by mounting
// the whole board hook. This module isolates the *rules* as a pure function that
// turns a board snapshot + the current and previous session maps into a flat list
// of intended moves. The caller stays responsible for *applying* each move (direct
// vs. animated) — see use-board-interactions.ts.

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTaskColumnId } from "@/state/board-state";
import type { BoardColumnId, BoardData } from "@/types";

export interface SessionReconcileAction {
	taskId: string;
	/** The card's current column, so the caller can route the move from the right place. */
	from: BoardColumnId;
	/** The column the session state implies the card should move to. */
	to: Extract<BoardColumnId, "review" | "in_progress" | "trash">;
}

type SessionMap = Record<string, RuntimeTaskSessionSummary>;

/**
 * Decide which cards should move based on their session state. Pure: it reads the
 * board snapshot and the session maps and returns intended moves in session order;
 * it never mutates anything. Each task appears at most once.
 *
 * `previousSessions` is what this browser last observed, used to distinguish a
 * genuine live transition from initial hydration — the interrupted -> trash rule
 * must NOT fire on hydration (e.g. a session that was already interrupted in
 * persisted state after a runtime restart), or restored cards get trashed.
 */
export function planSessionReconcile(
	board: BoardData,
	sessions: SessionMap,
	previousSessions: SessionMap,
): SessionReconcileAction[] {
	const actions: SessionReconcileAction[] = [];
	for (const summary of Object.values(sessions)) {
		const previous = previousSessions[summary.taskId];
		// Ignore a summary older than what we already processed (out-of-order delivery).
		if (previous && previous.updatedAt > summary.updatedAt) {
			continue;
		}
		const columnId = getTaskColumnId(board, summary.taskId);
		if (columnId === null) {
			continue;
		}
		const to = resolveTargetColumn(summary, columnId, previous);
		if (to) {
			actions.push({ taskId: summary.taskId, from: columnId, to });
		}
	}
	return actions;
}

function resolveTargetColumn(
	summary: RuntimeTaskSessionSummary,
	columnId: BoardColumnId,
	previous: RuntimeTaskSessionSummary | undefined,
): SessionReconcileAction["to"] | null {
	if (summary.state === "awaiting_review" && columnId === "in_progress") {
		return "review";
	}
	if (summary.state === "running" && columnId === "review") {
		return "in_progress";
	}
	if (
		summary.state === "interrupted" &&
		// Only auto-trash on a genuine live interruption observed in this browser session.
		// On initial hydration `previous` is undefined, so a session that was already
		// interrupted in persisted state (e.g. after a runtime restart) stays put and
		// remains resumable instead of being trashed.
		previous &&
		previous.state !== "interrupted" &&
		// Auto-trash only applies to active work columns. A task sitting in backlog (e.g.
		// one the user just dragged back, which stops its session) must never be trashed.
		(columnId === "in_progress" || columnId === "review")
	) {
		return "trash";
	}
	return null;
}
