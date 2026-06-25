import type { RuntimeWorkspaceSkill } from "@/runtime/types";

/** Skills installed within this window (ms) are considered "new". */
export const SKILL_NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Group label used for skills with no recorded install source (locally-created or legacy). */
export const OTHER_SKILLS_GROUP = "Other skills";

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
 * Groups skills by their install source. Sourced groups come first (alphabetical),
 * with the "Other skills" group always last. Skills keep their original relative order
 * within a group.
 */
export function groupSkillsBySource(skills: RuntimeWorkspaceSkill[]): SkillGroup[] {
	const groups = new Map<string, RuntimeWorkspaceSkill[]>();
	for (const skill of skills) {
		const label = skill.installedFrom ?? OTHER_SKILLS_GROUP;
		const existing = groups.get(label);
		if (existing) {
			existing.push(skill);
		} else {
			groups.set(label, [skill]);
		}
	}
	return [...groups.entries()]
		.map(([label, groupSkills]) => ({ label, skills: groupSkills }))
		.sort((a, b) => {
			if (a.label === OTHER_SKILLS_GROUP) return 1;
			if (b.label === OTHER_SKILLS_GROUP) return -1;
			return a.label.localeCompare(b.label);
		});
}
