import * as Popover from "@radix-ui/react-popover";
import type { ClaudePermissionStrategy, ClaudePermissionStrategyConfig } from "@runtime-claude-permission-strategy";
import { ShieldCheck } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";

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
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useClaudePermissionStrategyScope } from "@/hooks/use-claude-permission-strategy-scope";

interface TaskClaudePermissionModeButtonProps {
	taskId: string;
	/**
	 * True when the task's agent has already started (in progress / review). The
	 * strategy is applied at process spawn (it decides which CLI flag Claude Code
	 * gets), so applying a change to a running task requires restarting it — this
	 * gates the confirm-and-restart flow.
	 */
	requiresRestartToApply?: boolean;
	/**
	 * Restarts the task's agent so a freshly-saved strategy takes effect, resuming
	 * from the agent's persisted session. Only provided for running CLI tasks;
	 * absent for backlog cards (which simply apply it on their first start).
	 */
	onRequestRestart?: () => Promise<{ ok: boolean; message?: string }>;
	/**
	 * Notifies the host when the editor popover opens or closes. Hosts that close
	 * themselves on outside clicks (e.g. the inline task editor's pointerdown guard)
	 * use this to ignore clicks that land in the portaled popover.
	 */
	onPopoverOpenChange?: (open: boolean) => void;
}

const USE_DEFAULT_VALUE = "__use_default__";

/**
 * Per-task Claude Code permission strategy editor. Edits the task scope of the
 * hub-central config (`tasks[taskId]`), which layers over the global and
 * project scopes. Only meaningful when the task's effective agent is Claude
 * Code — callers gate rendering on that.
 *
 * On a backlog card the choice applies on the task's first start. On a running
 * task the strategy is already baked into the agent process, so saving
 * prompts to restart the agent CLI and applies the change on confirmation.
 */
export function TaskClaudePermissionModeButton({
	taskId,
	requiresRestartToApply,
	onRequestRestart,
	onPopoverOpenChange,
}: TaskClaudePermissionModeButtonProps): ReactElement {
	const [open, setOpen] = useState(false);
	const { value, setValue, isDirty, isLoading, isSaving, save } = useClaudePermissionStrategyScope(
		{ kind: "task", taskId },
		open,
	);
	const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);
	const [isRestarting, setIsRestarting] = useState(false);

	// Mirror the popover (and the restart confirmation that keeps it mounted) up to
	// the host so its own outside-click handling can ignore clicks in our portal.
	useEffect(() => {
		onPopoverOpenChange?.(open || confirmRestartOpen);
	}, [open, confirmRestartOpen, onPopoverOpenChange]);

	const busy = isSaving || isRestarting;

	// Persist the edited task scope back to the hub config. Returns the saved
	// config on success (or null on failure) so callers can chain a restart.
	const persist = async (): Promise<ClaudePermissionStrategyConfig | null> => {
		try {
			return await save();
		} catch {
			toast.error("Failed to save the task's permission mode");
			return null;
		}
	};

	const handleSaveOnly = async (): Promise<void> => {
		const saved = await persist();
		if (saved) {
			toast.success("Task permission mode saved");
			setOpen(false);
		}
	};

	const handleSaveAndRestart = async (): Promise<void> => {
		const saved = await persist();
		if (!saved) {
			return;
		}
		setConfirmRestartOpen(false);
		setOpen(false);
		if (!onRequestRestart) {
			toast.success("Task permission mode saved");
			return;
		}
		setIsRestarting(true);
		try {
			const result = await onRequestRestart();
			if (result.ok) {
				toast.success("Permission mode saved — restarting the agent to apply it");
			} else {
				toast.error(result.message ?? "Saved, but the agent restart failed");
			}
		} finally {
			setIsRestarting(false);
		}
	};

	const handleSaveClick = (): void => {
		// A running CLI task needs a restart to pick up a changed strategy. Confirm it first.
		if (requiresRestartToApply && onRequestRestart && isDirty) {
			setConfirmRestartOpen(true);
			return;
		}
		void handleSaveOnly();
	};

	return (
		<>
			<Popover.Root
				open={open}
				onOpenChange={(next) => {
					// Keep the editor open behind the restart confirmation so canceling
					// returns to the in-progress edit rather than discarding it.
					if (!next && confirmRestartOpen) {
						return;
					}
					setOpen(next);
				}}
			>
				<Popover.Trigger asChild>
					<Button
						variant="default"
						size="sm"
						icon={<ShieldCheck size={14} />}
						aria-label="Edit the Claude Code permission mode for this task"
					>
						{value === "auto" ? "Auto" : value === "bypass" ? "Bypass" : "Permission mode"}
					</Button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="end"
						sideOffset={6}
						className="z-50 flex w-72 flex-col gap-2 rounded-md border border-border bg-surface-1 p-3 shadow-lg"
					>
						<span className="text-[12px] font-semibold text-text-primary">Claude Code permission mode</span>
						{isLoading ? (
							<div className="flex items-center gap-2 py-2 text-[12px] text-text-secondary">
								<Spinner size={13} /> Loading…
							</div>
						) : (
							<NativeSelect
								value={value ?? USE_DEFAULT_VALUE}
								onChange={(event) =>
									setValue(
										event.target.value === USE_DEFAULT_VALUE
											? null
											: (event.target.value as ClaudePermissionStrategy),
									)
								}
								disabled={busy}
							>
								<option value={USE_DEFAULT_VALUE}>Use project/global default</option>
								<option value="bypass">Bypass permissions</option>
								<option value="auto">Auto mode</option>
							</NativeSelect>
						)}
						<p className="text-[11px] text-text-tertiary">
							{requiresRestartToApply
								? "Overrides global and project defaults. The agent restarts to apply changes."
								: "Applied the next time this task starts. Overrides global and project defaults."}
						</p>
						<div className="flex justify-end">
							<Button variant="primary" size="sm" onClick={handleSaveClick} disabled={isLoading || busy}>
								{isSaving ? "Saving…" : "Save"}
							</Button>
						</div>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
			<AlertDialog open={confirmRestartOpen} onOpenChange={setConfirmRestartOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Restart the agent to apply?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						The permission mode is applied when the agent process starts, so this task's running CLI won't pick up
						the change on its own. Saving will restart the agent now to apply it — it resumes from its existing
						session, and any in-flight turn is interrupted.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" disabled={busy}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							disabled={busy}
							onClick={(event) => {
								// Keep the dialog mounted until the save+restart resolves.
								event.preventDefault();
								void handleSaveAndRestart();
							}}
						>
							{busy ? "Restarting…" : "Save & restart"}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
