import * as Popover from "@radix-ui/react-popover";
import { BookPlus } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SkillSelectorList } from "@/components/skills/skill-selector-list";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
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
	/**
	 * Restarts the task's agent so it reloads its skill list. CLI agents (Claude Code,
	 * Codex, …) snapshot skills at process start, so a live session cannot see files
	 * synced mid-run; when set, a successful sync prompts to confirm a restart. Leave
	 * unset for the in-process Cline agent, which re-reads the worktree each turn.
	 */
	onRequestRestart?: () => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Dedicated control for adding/removing skills on an in-progress or review ticket. Toggling
 * a skill copies it into (or removes it from) the task's existing worktree via the
 * runtime.syncTaskSkills endpoint. Agents that snapshot skills at startup are offered a
 * confirm-then-restart (the agent resumes its conversation from its persisted session).
 */
export function TaskSkillsButton({
	workspaceId,
	taskId,
	baseRef,
	agentId,
	selectedSkillNames,
	onPersist,
	onRequestRestart,
}: TaskSkillsButtonProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [skills, setSkills] = useState<RuntimeWorkspaceSkill[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);
	const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);
	const [isRestarting, setIsRestarting] = useState(false);

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
					if (!result.ok) {
						toast.error(result.error ?? "Failed to update task skills");
						return;
					}
					if (onRequestRestart) {
						// Files are synced, but the running agent snapshotted its skills at
						// startup — ask before bouncing it so a mid-turn restart is deliberate.
						setConfirmRestartOpen(true);
					} else {
						toast.success("Task skills updated");
					}
				})
				.catch(() => toast.error("Failed to update task skills"))
				.finally(() => setIsSyncing(false));
		},
		[agentId, baseRef, onPersist, taskId, workspaceId, onRequestRestart],
	);

	const handleConfirmRestart = useCallback(async () => {
		if (!onRequestRestart) {
			return;
		}
		setIsRestarting(true);
		try {
			const result = await onRequestRestart();
			if (result.ok) {
				toast.success("Skills updated — restarting the agent to load them");
			} else {
				toast.error(result.message ?? "Skills synced, but the agent restart failed");
			}
		} catch {
			toast.error("Skills synced, but the agent restart failed");
		} finally {
			setIsRestarting(false);
			setConfirmRestartOpen(false);
		}
	}, [onRequestRestart]);

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
						{onRequestRestart
							? "Skills are copied into the task worktree; the agent restarts to load them."
							: "Added skills are copied into the task worktree; the agent picks them up on its next turn."}
					</p>
				</Popover.Content>
			</Popover.Portal>
			<AlertDialog open={confirmRestartOpen} onOpenChange={setConfirmRestartOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Restart the agent to load skills?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						The skill files are synced to the worktree, but this agent reads its skill list when its process
						starts, so the running session can't see the change. Restarting applies it now — the agent resumes
						from its existing session, and any in-flight turn is interrupted. If you skip this, the new skills
						load on the next manual restart.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" disabled={isRestarting}>
							Not now
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							disabled={isRestarting}
							onClick={(event) => {
								// Keep the dialog mounted until the restart resolves.
								event.preventDefault();
								void handleConfirmRestart();
							}}
						>
							{isRestarting ? "Restarting…" : "Restart agent"}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</Popover.Root>
	);
}
