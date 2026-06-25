import { describe, expect, it } from "vitest";

import { buildClaudeSkillOverrides } from "../../../src/workspace/skill-isolation";

describe("buildClaudeSkillOverrides", () => {
	it('turns every non-selected discoverable skill to "off"', () => {
		const overrides = buildClaudeSkillOverrides(["frontend-design", "retro", "spec", "docx"], ["frontend-design"]);
		expect(overrides).toEqual({ retro: "off", spec: "off", docx: "off" });
	});

	it("omits selected skills so they keep their default visibility", () => {
		const overrides = buildClaudeSkillOverrides(["a", "b", "c"], ["a", "c"]);
		expect(overrides).toEqual({ b: "off" });
		expect("a" in overrides).toBe(false);
		expect("c" in overrides).toBe(false);
	});

	it("returns an empty map when everything is selected", () => {
		expect(buildClaudeSkillOverrides(["a", "b"], ["a", "b"])).toEqual({});
	});

	it("ignores selected names that are not discoverable", () => {
		expect(buildClaudeSkillOverrides(["a"], ["a", "ghost"])).toEqual({});
	});
});
