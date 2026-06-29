import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight, HelpCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { groupSkillsBySource } from "@/components/skills/skill-grouping";
import { SkillSwitch } from "@/components/skills/skill-switch";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeWorkspaceSkill } from "@/runtime/types";
import { readSkillUsageCounts } from "@/storage/skill-preferences";

interface SkillSelectorListProps {
	workspaceId: string | null;
	workspaceSkills: RuntimeWorkspaceSkill[];
	skillNames: string[];
	onSkillNamesChange: (value: string[]) => void;
	/** Prefix for checkbox element ids so multiple lists can coexist on one screen. */
	idPrefix?: string;
}

/**
 * The grouped, toggle-able list of workspace skills used to pick which skills apply to a
 * task. Shared by the task create/edit Advanced picker and the in-progress "Add skill"
 * popover so both stay in sync. Renders nothing when there are no enabled skills.
 */
export function SkillSelectorList({
	workspaceId,
	workspaceSkills,
	skillNames,
	onSkillNamesChange,
	idPrefix = "task-skill",
}: SkillSelectorListProps): ReactElement | null {
	// Only enabled skills are selectable per task; disabling a skill in settings hides it here.
	// Within each source group, surface the skills used most often in this workspace first.
	const skillUsageCounts = useMemo(() => readSkillUsageCounts(workspaceId), [workspaceId]);
	const skillGroups = useMemo(() => {
		const groups = groupSkillsBySource(workspaceSkills.filter((skill) => !skill.disabled));
		return groups.map((group) => ({
			...group,
			skills: [...group.skills].sort((a, b) => (skillUsageCounts[b.name] ?? 0) - (skillUsageCounts[a.name] ?? 0)),
		}));
	}, [workspaceSkills, skillUsageCounts]);

	if (skillGroups.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2">
			{skillGroups.map((group) => {
				const groupNames = group.skills.map((s) => s.name);
				const allSelected = groupNames.every((n) => skillNames.includes(n));
				return (
					<Collapsible.Root key={group.label} defaultOpen className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<Collapsible.Trigger className="group flex flex-1 items-center gap-1.5 min-w-0 text-left text-[11px] font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary">
								<ChevronRight
									size={12}
									className="flex-shrink-0 transition-transform group-data-[state=open]:rotate-90"
								/>
								<span className="truncate">{group.label}</span>
								<span className="text-text-tertiary font-normal normal-case tracking-normal">
									{group.skills.length}
								</span>
							</Collapsible.Trigger>
							<SkillSwitch
								checked={allSelected}
								onCheckedChange={(next) => {
									if (next) {
										onSkillNamesChange([...new Set([...skillNames, ...groupNames])]);
									} else {
										onSkillNamesChange(skillNames.filter((n) => !groupNames.includes(n)));
									}
								}}
							/>
						</div>
						<Collapsible.Content className="flex flex-col gap-1 pl-3.5">
							{group.skills.map((skill) => {
								const checked = skillNames.includes(skill.name);
								const checkboxId = `${idPrefix}-${skill.name}`;
								return (
									<div key={skill.name} className="flex items-center gap-2 select-none">
										<SkillSwitch
											id={checkboxId}
											checked={checked}
											onCheckedChange={(next) => {
												if (next) {
													onSkillNamesChange([...skillNames, skill.name]);
												} else {
													onSkillNamesChange(skillNames.filter((n) => n !== skill.name));
												}
											}}
										/>
										<label
											htmlFor={checkboxId}
											className="flex items-center gap-1 min-w-0 text-[12px] text-text-primary leading-tight cursor-pointer"
										>
											<span className="truncate">{skill.name}</span>
											{skill.description ? (
												<Tooltip
													content={skill.description}
													className="max-w-xs whitespace-normal break-words"
												>
													<HelpCircle
														size={12}
														className="flex-shrink-0 text-text-tertiary hover:text-text-secondary"
													/>
												</Tooltip>
											) : null}
										</label>
									</div>
								);
							})}
						</Collapsible.Content>
					</Collapsible.Root>
				);
			})}
		</div>
	);
}
