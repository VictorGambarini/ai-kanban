import { beforeEach, describe, expect, it } from "vitest";

import { readLastUsedSkillNames, readSkillUsageCounts, recordSkillSelection } from "./skill-preferences";

const WS = "workspace-1";

beforeEach(() => {
	localStorage.clear();
});

describe("skill-preferences", () => {
	it("returns empty defaults when nothing is stored", () => {
		expect(readLastUsedSkillNames(WS)).toEqual([]);
		expect(readSkillUsageCounts(WS)).toEqual({});
	});

	it("remembers the last selection and increments usage counts", () => {
		recordSkillSelection(WS, ["docx", "grill-me"]);
		expect(readLastUsedSkillNames(WS)).toEqual(["docx", "grill-me"]);
		expect(readSkillUsageCounts(WS)).toEqual({ docx: 1, "grill-me": 1 });

		recordSkillSelection(WS, ["docx"]);
		expect(readLastUsedSkillNames(WS)).toEqual(["docx"]);
		expect(readSkillUsageCounts(WS)).toEqual({ docx: 2, "grill-me": 1 });
	});

	it("records an empty selection so the next task starts empty", () => {
		recordSkillSelection(WS, ["docx"]);
		recordSkillSelection(WS, []);
		expect(readLastUsedSkillNames(WS)).toEqual([]);
		// Counts are cumulative and not decremented.
		expect(readSkillUsageCounts(WS)).toEqual({ docx: 1 });
	});

	it("scopes data per workspace", () => {
		recordSkillSelection(WS, ["docx"]);
		recordSkillSelection("workspace-2", ["pptx"]);
		expect(readLastUsedSkillNames(WS)).toEqual(["docx"]);
		expect(readLastUsedSkillNames("workspace-2")).toEqual(["pptx"]);
	});

	it("no-ops for a null workspace id", () => {
		recordSkillSelection(null, ["docx"]);
		expect(readLastUsedSkillNames(null)).toEqual([]);
		expect(readSkillUsageCounts(null)).toEqual({});
	});

	it("ignores corrupt stored values", () => {
		localStorage.setItem("kanban.skill-prefs.lastUsed.workspace-1", "{not json");
		localStorage.setItem("kanban.skill-prefs.usage.workspace-1", "[1,2,3]");
		expect(readLastUsedSkillNames(WS)).toEqual([]);
		expect(readSkillUsageCounts(WS)).toEqual({});
	});
});
