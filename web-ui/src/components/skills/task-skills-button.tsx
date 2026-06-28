import * as Popover from "@radix-ui/react-popover";
import { BookPlus } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SkillSelectorList } from "@/components/skills/skill-selector-list";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fetchWorkspaceSkills, syncTaskSkills } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeWorkspaceSkill } from "@/runtime/types";

interface TaskSkillsButtonProps {
	workspaceId: string | null;
	taskId: string;
	baseRef: string;
	agentId?: RuntimeAgentId;
	selectedSkillNames: string[];
	/** Persist the new selection to the board card (called before the worktree sync resolves). */
	onPersist: (skillNames: string[]) => void;
}

/**
 * Dedicated control for adding/removing skills on an in-progress or review ticket. Toggling
 * a skill copies it into (or removes it from) the task's existing worktree via the
 * runtime.syncTaskSkills endpoint, so the running agent picks it up on its next turn —
 * no session restart needed.
 */
export function TaskSkillsButton({
	workspaceId,
	taskId,
	baseRef,
	agentId,
	selectedSkillNames,
	onPersist,
}: TaskSkillsButtonProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [skills, setSkills] = useState<RuntimeWorkspaceSkill[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);

	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		void fetchWorkspaceSkills(workspaceId)
			.then((next) => {
				if (!cancelled) {
					setSkills(next);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSkills([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [open, workspaceId]);

	const handleChange = useCallback(
		(nextSkillNames: string[]) => {
			// Optimistically update the board card, then sync the worktree files.
			onPersist(nextSkillNames);
			setIsSyncing(true);
			void syncTaskSkills(workspaceId, { taskId, baseRef, agentId, skillNames: nextSkillNames })
				.then((result) => {
					if (result.ok) {
						toast.success("Task skills updated");
					} else {
						toast.error(result.error ?? "Failed to update task skills");
					}
				})
				.catch(() => toast.error("Failed to update task skills"))
				.finally(() => setIsSyncing(false));
		},
		[agentId, baseRef, onPersist, taskId, workspaceId],
	);

	const hasEnabledSkills = skills.some((skill) => !skill.disabled);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<Button
					variant="default"
					size="sm"
					icon={isSyncing ? <Spinner size={13} /> : <BookPlus size={14} />}
					aria-label="Add or remove skills for this task"
				>
					{`Skills${selectedSkillNames.length > 0 ? ` (${selectedSkillNames.length})` : ""}`}
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-50 flex max-h-[60vh] w-72 flex-col gap-2 overflow-y-auto rounded-md border border-border bg-surface-1 p-3 shadow-lg"
				>
					<span className="text-[12px] font-semibold text-text-primary">Task skills</span>
					{isLoading ? (
						<div className="flex items-center gap-2 py-2 text-[12px] text-text-secondary">
							<Spinner size={13} /> Loading…
						</div>
					) : hasEnabledSkills ? (
						<SkillSelectorList
							workspaceId={workspaceId}
							workspaceSkills={skills}
							skillNames={selectedSkillNames}
							onSkillNamesChange={handleChange}
							idPrefix={`task-${taskId}-skill`}
						/>
					) : (
						<p className="py-1 text-[12px] text-text-secondary">No skills available. Add skills in Settings.</p>
					)}
					<p className="text-[11px] text-text-tertiary">
						Added skills are copied into the task worktree; the agent picks them up on its next turn.
					</p>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
