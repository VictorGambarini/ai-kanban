import * as Popover from "@radix-ui/react-popover";
import type { AgentEnvConfig } from "@runtime-agent-env";
import { KeyRound } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";

import { EnvVarsEditor } from "@/components/agent-env/env-vars-editor";
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
import { useAgentEnvScope } from "@/hooks/use-agent-env-scope";

interface TaskEnvButtonProps {
	taskId: string;
	/**
	 * True when the task's agent has already started (in progress / review). Custom
	 * env is injected at process spawn, so applying changes to a running CLI agent
	 * requires restarting it — this gates the confirm-and-restart flow.
	 */
	requiresRestartToApply?: boolean;
	/**
	 * Restarts the task's agent so freshly-saved env takes effect, resuming from the
	 * agent's persisted session. Only provided for running CLI tasks; absent for
	 * backlog cards (which simply apply env on their first start).
	 */
	onRequestRestart?: () => Promise<{ ok: boolean; message?: string }>;
	/**
	 * Notifies the host when the editor popover opens or closes. Hosts that close
	 * themselves on outside clicks (e.g. the inline task editor's pointerdown guard)
	 * use this to ignore clicks that land in the portaled popover.
	 */
	onPopoverOpenChange?: (open: boolean) => void;
}

/**
 * Per-task custom env editor. Edits the task scope of the hub-central env config
 * (`tasks[taskId]`), which layers over the global and project scopes.
 *
 * On a backlog card the values apply on the task's first start. On a running task
 * env is already baked into the agent process, so saving prompts to restart the
 * agent CLI and applies the change on confirmation.
 */
export function TaskEnvButton({
	taskId,
	requiresRestartToApply,
	onRequestRestart,
	onPopoverOpenChange,
}: TaskEnvButtonProps): ReactElement {
	const [open, setOpen] = useState(false);
	const { rows, setRows, isDirty, varCount, isLoading, isSaving, save } = useAgentEnvScope(
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
	const persist = async (): Promise<AgentEnvConfig | null> => {
		try {
			return await save();
		} catch {
			toast.error("Failed to save task environment");
			return null;
		}
	};

	const handleSaveOnly = async (): Promise<void> => {
		const saved = await persist();
		if (saved) {
			toast.success("Task environment saved");
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
			toast.success("Task environment saved");
			return;
		}
		setIsRestarting(true);
		try {
			const result = await onRequestRestart();
			if (result.ok) {
				toast.success("Environment saved — restarting the agent to apply it");
			} else {
				toast.error(result.message ?? "Saved, but the agent restart failed");
			}
		} finally {
			setIsRestarting(false);
		}
	};

	const handleSaveClick = (): void => {
		// A running CLI task needs a restart to pick up changed env. Confirm it first.
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
					// returns to the in-progress edits rather than discarding them.
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
						icon={<KeyRound size={14} />}
						aria-label="Edit environment variables for this task"
					>
						{`Env${varCount > 0 ? ` (${varCount})` : ""}`}
					</Button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="end"
						sideOffset={6}
						className="z-50 flex max-h-[60vh] w-80 flex-col gap-2 overflow-y-auto rounded-md border border-border bg-surface-1 p-3 shadow-lg"
					>
						<span className="text-[12px] font-semibold text-text-primary">Task environment</span>
						{isLoading ? (
							<div className="flex items-center gap-2 py-2 text-[12px] text-text-secondary">
								<Spinner size={13} /> Loading…
							</div>
						) : (
							<EnvVarsEditor
								rows={rows}
								onChange={setRows}
								disabled={busy}
								emptyLabel="No task-specific variables. These override global and project vars."
							/>
						)}
						<p className="text-[11px] text-text-tertiary">
							{requiresRestartToApply
								? "Layers over global and project variables. The agent restarts to apply changes."
								: "Applied the next time this task starts. Layers over global and project variables."}
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
						Environment variables are applied when the agent process starts, so this task's running CLI won't pick
						up the change on its own. Saving will restart the agent now to apply the new environment — it resumes
						from its existing session, and any in-flight turn is interrupted.
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
