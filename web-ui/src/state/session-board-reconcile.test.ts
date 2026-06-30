import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { planSessionReconcile } from "@/state/session-board-reconcile";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

function card(id: string): BoardCard {
	return { id, title: id, description: "", dependencies: [] } as unknown as BoardCard;
}

function board(placement: Partial<Record<BoardColumnId, string[]>>): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return {
		columns: columnIds.map((id) => ({
			id,
			title: id,
			cards: (placement[id] ?? []).map(card),
		})),
	} as unknown as BoardData;
}

function session(taskId: string, state: RuntimeTaskSessionSummary["state"], updatedAt = 1): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		updatedAt,
		mode: null,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	} as unknown as RuntimeTaskSessionSummary;
}

function map(...summaries: RuntimeTaskSessionSummary[]): Record<string, RuntimeTaskSessionSummary> {
	return Object.fromEntries(summaries.map((s) => [s.taskId, s]));
}

describe("planSessionReconcile", () => {
	it("moves an awaiting_review task out of in_progress into review", () => {
		const actions = planSessionReconcile(board({ in_progress: ["t1"] }), map(session("t1", "awaiting_review")), {});
		expect(actions).toEqual([{ taskId: "t1", from: "in_progress", to: "review" }]);
	});

	it("moves a running task out of review back into in_progress", () => {
		const actions = planSessionReconcile(board({ review: ["t1"] }), map(session("t1", "running")), {});
		expect(actions).toEqual([{ taskId: "t1", from: "review", to: "in_progress" }]);
	});

	it("does not move awaiting_review when the card is not in in_progress", () => {
		const actions = planSessionReconcile(board({ review: ["t1"] }), map(session("t1", "awaiting_review")), {});
		expect(actions).toEqual([]);
	});

	it("trashes a task that transitions to interrupted while in an active column", () => {
		const sessions = map(session("t1", "interrupted", 2));
		const previous = map(session("t1", "running", 1));
		const actions = planSessionReconcile(board({ in_progress: ["t1"] }), sessions, previous);
		expect(actions).toEqual([{ taskId: "t1", from: "in_progress", to: "trash" }]);
	});

	it("does NOT trash an interrupted task on initial hydration (no previous session)", () => {
		const actions = planSessionReconcile(board({ in_progress: ["t1"] }), map(session("t1", "interrupted")), {});
		expect(actions).toEqual([]);
	});

	it("does NOT trash a task that was already interrupted (no live transition)", () => {
		const sessions = map(session("t1", "interrupted", 2));
		const previous = map(session("t1", "interrupted", 1));
		const actions = planSessionReconcile(board({ in_progress: ["t1"] }), sessions, previous);
		expect(actions).toEqual([]);
	});

	it("does NOT trash an interrupted task sitting in backlog", () => {
		const sessions = map(session("t1", "interrupted", 2));
		const previous = map(session("t1", "running", 1));
		const actions = planSessionReconcile(board({ backlog: ["t1"] }), sessions, previous);
		expect(actions).toEqual([]);
	});

	it("ignores a summary older than the previously observed one (out-of-order delivery)", () => {
		const sessions = map(session("t1", "awaiting_review", 1));
		const previous = map(session("t1", "running", 5));
		const actions = planSessionReconcile(board({ in_progress: ["t1"] }), sessions, previous);
		expect(actions).toEqual([]);
	});

	it("ignores sessions for tasks not on the board", () => {
		const actions = planSessionReconcile(board({}), map(session("ghost", "awaiting_review")), {});
		expect(actions).toEqual([]);
	});

	it("plans independent moves for several sessions at once", () => {
		const sessions = map(session("a", "awaiting_review"), session("b", "running"), session("c", "interrupted", 2));
		const previous = map(session("c", "running", 1));
		const actions = planSessionReconcile(board({ in_progress: ["a", "c"], review: ["b"] }), sessions, previous);
		expect(actions).toEqual([
			{ taskId: "a", from: "in_progress", to: "review" },
			{ taskId: "b", from: "review", to: "in_progress" },
			{ taskId: "c", from: "in_progress", to: "trash" },
		]);
	});
});
