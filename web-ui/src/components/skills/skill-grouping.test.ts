import { describe, expect, it } from "vitest";

import {
	GLOBAL_SKILLS_GROUP,
	groupSkillsBySource,
	isGlobalSkill,
	isSkillNew,
	OTHER_SKILLS_GROUP,
	SKILL_NEW_WINDOW_MS,
} from "@/components/skills/skill-grouping";
import type { RuntimeWorkspaceSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeWorkspaceSkill> & { name: string }): RuntimeWorkspaceSkill {
	return { disabled: false, dirPath: `/skills/${overrides.name}`, ...overrides };
}

describe("groupSkillsBySource", () => {
	it("orders sourced groups alphabetically, then Other, then Global last", () => {
		const groups = groupSkillsBySource([
			skill({ name: "local-one" }),
			skill({ name: "world", scope: "global" }),
			skill({ name: "z-skill", installedFrom: "zeta/repo", scope: "project" }),
			skill({ name: "a-skill", installedFrom: "alpha/repo", scope: "project" }),
		]);
		expect(groups.map((g) => g.label)).toEqual(["alpha/repo", "zeta/repo", OTHER_SKILLS_GROUP, GLOBAL_SKILLS_GROUP]);
	});

	it("puts global skills in the Global group even when they carry an installedFrom", () => {
		const groups = groupSkillsBySource([skill({ name: "g", scope: "global", installedFrom: "some/source" })]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe(GLOBAL_SKILLS_GROUP);
	});

	it("keeps same-named project and global skills as separate entries", () => {
		const groups = groupSkillsBySource([
			skill({ name: "qa", scope: "project", installedFrom: "mattpocock/skills" }),
			skill({ name: "qa", scope: "global" }),
		]);
		expect(groups.map((g) => g.label)).toEqual(["mattpocock/skills", GLOBAL_SKILLS_GROUP]);
		expect(groups.flatMap((g) => g.skills).filter((s) => s.name === "qa")).toHaveLength(2);
	});

	it("treats skills without a scope (older runtimes) as project skills", () => {
		expect(isGlobalSkill(skill({ name: "legacy" }))).toBe(false);
		const groups = groupSkillsBySource([skill({ name: "legacy" })]);
		expect(groups[0]?.label).toBe(OTHER_SKILLS_GROUP);
	});
});

describe("isSkillNew", () => {
	it("is true within the window and false outside it", () => {
		const now = Date.now();
		const fresh = skill({ name: "f", installedAt: new Date(now - 1000).toISOString() });
		const stale = skill({ name: "s", installedAt: new Date(now - SKILL_NEW_WINDOW_MS - 1000).toISOString() });
		expect(isSkillNew(fresh, now)).toBe(true);
		expect(isSkillNew(stale, now)).toBe(false);
	});

	it("is false without a parseable installedAt", () => {
		expect(isSkillNew(skill({ name: "n" }))).toBe(false);
		expect(isSkillNew(skill({ name: "bad", installedAt: "not-a-date" }))).toBe(false);
	});
});
