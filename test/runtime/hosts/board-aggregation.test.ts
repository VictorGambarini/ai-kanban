import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	HOST_NAMESPACE_SEPARATOR,
	mergeBoards,
	mergeSessions,
	namespaceTaskId,
	parseNamespacedTaskId,
} from "../../../src/hosts/board-aggregation";
import { LOCAL_HOST_ID } from "../../../src/hosts/host-proxy";

function card(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: `prompt-${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function board(
	cards: { backlog?: RuntimeBoardCard[]; in_progress?: RuntimeBoardCard[] },
	deps: RuntimeBoardDependency[] = [],
): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: cards.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: cards.in_progress ?? [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: deps,
	};
}

describe("task id namespacing", () => {
	it("namespaces remote ids and round-trips them", () => {
		const namespaced = namespaceTaskId("van-one", "task-7");
		expect(namespaced).toBe(`van-one${HOST_NAMESPACE_SEPARATOR}task-7`);
		expect(parseNamespacedTaskId(namespaced)).toEqual({ hostId: "van-one", taskId: "task-7" });
	});

	it("leaves local ids untouched and parses bare ids as local", () => {
		expect(namespaceTaskId(LOCAL_HOST_ID, "task-7")).toBe("task-7");
		expect(parseNamespacedTaskId("task-7")).toEqual({ hostId: LOCAL_HOST_ID, taskId: "task-7" });
	});
});

describe("mergeBoards", () => {
	it("merges cards from each host into canonical columns with namespaced ids", () => {
		const merged = mergeBoards([
			{ hostId: LOCAL_HOST_ID, board: board({ backlog: [card("a")] }) },
			{ hostId: "van-one", board: board({ backlog: [card("b")], in_progress: [card("c")] }) },
		]);

		expect(merged.columns.map((column) => column.id)).toEqual(["backlog", "in_progress", "review", "trash"]);
		const backlogIds = merged.columns[0]?.cards.map((c) => c.id);
		expect(backlogIds).toEqual(["a", `van-one${HOST_NAMESPACE_SEPARATOR}b`]);
		expect(merged.columns[1]?.cards.map((c) => c.id)).toEqual([`van-one${HOST_NAMESPACE_SEPARATOR}c`]);
	});

	it("namespaces dependency ids and endpoints by host", () => {
		const merged = mergeBoards([
			{
				hostId: "van-one",
				board: board({ backlog: [card("a"), card("b")] }, [
					{ id: "dep-1", fromTaskId: "a", toTaskId: "b", createdAt: 1 },
				]),
			},
		]);
		expect(merged.dependencies).toEqual([
			{
				id: `van-one${HOST_NAMESPACE_SEPARATOR}dep-1`,
				fromTaskId: `van-one${HOST_NAMESPACE_SEPARATOR}a`,
				toTaskId: `van-one${HOST_NAMESPACE_SEPARATOR}b`,
				createdAt: 1,
			},
		]);
	});
});

describe("mergeSessions", () => {
	it("namespaces session keys and the taskId inside each summary", () => {
		const summary: RuntimeTaskSessionSummary = {
			taskId: "task-1",
			state: "running",
			agentId: null,
			workspacePath: null,
			pid: null,
			startedAt: null,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		};
		const merged = mergeSessions([{ hostId: "van-one", sessions: { "task-1": summary } }]);
		const key = `van-one${HOST_NAMESPACE_SEPARATOR}task-1`;
		expect(Object.keys(merged)).toEqual([key]);
		expect(merged[key]?.taskId).toBe(key);
	});
});
