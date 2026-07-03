import type { RuntimeWorkspaceSkill } from "@/runtime/types";

/** Skills installed within this window (ms) are considered "new". */
export const SKILL_NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Group label used for skills with no recorded install source (locally-created or legacy). */
export const OTHER_SKILLS_GROUP = "Other skills";

/** Group label for skills discovered in the user's home directories rather than the project. */
export const GLOBAL_SKILLS_GROUP = "Global skills";

/** Returns true when the skill lives outside the project (user-level install). */
export function isGlobalSkill(skill: RuntimeWorkspaceSkill): boolean {
	// Older runtimes don't send `scope`; everything they list is treated as project.
	return skill.scope === "global";
}

export interface SkillGroup {
	/** The install source slug (e.g. "anthropics/skills"), or OTHER_SKILLS_GROUP. */
	label: string;
	skills: RuntimeWorkspaceSkill[];
}

/** Returns true when the skill was installed recently enough to flag as new. */
export function isSkillNew(skill: RuntimeWorkspaceSkill, now: number = Date.now()): boolean {
	if (!skill.installedAt) {
		return false;
	}
	const installedAt = Date.parse(skill.installedAt);
	if (Number.isNaN(installedAt)) {
		return false;
	}
	return now - installedAt < SKILL_NEW_WINDOW_MS;
}

/**
 * Groups skills by their install source. Sourced groups come first (alphabetical), then
 * the "Other skills" group, then the "Global skills" group (home-directory installs)
 * always last. Skills keep their original relative order within a group.
 */
export function groupSkillsBySource(skills: RuntimeWorkspaceSkill[]): SkillGroup[] {
	const groups = new Map<string, RuntimeWorkspaceSkill[]>();
	for (const skill of skills) {
		const label = isGlobalSkill(skill) ? GLOBAL_SKILLS_GROUP : (skill.installedFrom ?? OTHER_SKILLS_GROUP);
		const existing = groups.get(label);
		if (existing) {
			existing.push(skill);
		} else {
			groups.set(label, [skill]);
		}
	}
	const rank = (label: string): number => (label === GLOBAL_SKILLS_GROUP ? 2 : label === OTHER_SKILLS_GROUP ? 1 : 0);
	return [...groups.entries()]
		.map(([label, groupSkills]) => ({ label, skills: groupSkills }))
		.sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
}
