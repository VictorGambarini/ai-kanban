import * as Popover from "@radix-ui/react-popover";
import type { AgentEnvConfig, AgentEnvMap } from "@runtime-agent-env";
import { KeyRound } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";

import { type EnvRow, mapToRows, rowsToMap } from "@/components/agent-env/agent-env-rows";
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
import { fetchAgentEnvConfig, saveAgentEnvConfig } from "@/runtime/runtime-config-query";

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
}

function envMapsEqual(a: AgentEnvMap, b: AgentEnvMap): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	return aKeys.every((key) => a[key] === b[key]);
}

/**
 * Per-task custom env editor. Edits the task scope of the hub-central env config
 * (`tasks[taskId]`), which layers over the global and project scopes.
 *
 * On a backlog card the values apply on the task's first start. On a running task
 * env is already baked into the agent process, so saving prompts to restart the
 * agent CLI and applies the change on confirmation.
 */
export function TaskEnvButton({ taskId, requiresRestartToApply, onRequestRestart }: TaskEnvButtonProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [config, setConfig] = useState<AgentEnvConfig | null>(null);
	const [rows, setRows] = useState<EnvRow[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);
	const [isRestarting, setIsRestarting] = useState(false);

	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		void fetchAgentEnvConfig()
			.then((next) => {
				if (cancelled) {
					return;
				}
				setConfig(next);
				setRows(mapToRows(next.tasks[taskId] ?? {}));
			})
			.catch(() => {
				if (!cancelled) {
					setConfig({ global: {}, projects: {}, tasks: {} });
					setRows([]);
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
	}, [open, taskId]);

	const taskVarCount = config ? Object.keys(config.tasks[taskId] ?? {}).length : 0;
	const hasChanges = config ? !envMapsEqual(config.tasks[taskId] ?? {}, rowsToMap(rows)) : false;
	const busy = isSaving || isRestarting;

	// Persist the edited task scope back to the hub config. Returns the saved
	// config on success (or null on failure) so callers can chain a restart.
	const persist = async (): Promise<AgentEnvConfig | null> => {
		if (!config) {
			return null;
		}
		const nextTasks: AgentEnvConfig["tasks"] = { ...config.tasks };
		const nextMap = rowsToMap(rows);
		if (Object.keys(nextMap).length > 0) {
			nextTasks[taskId] = nextMap;
		} else {
			delete nextTasks[taskId];
		}
		const nextConfig: AgentEnvConfig = { global: config.global, projects: config.projects, tasks: nextTasks };
		setIsSaving(true);
		try {
			const saved = await saveAgentEnvConfig(nextConfig);
			setConfig(saved);
			setRows(mapToRows(saved.tasks[taskId] ?? {}));
			return saved;
		} catch {
			toast.error("Failed to save task environment");
			return null;
		} finally {
			setIsSaving(false);
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
		if (!config) {
			return;
		}
		// A running CLI task needs a restart to pick up changed env. Confirm it first.
		if (requiresRestartToApply && onRequestRestart && hasChanges) {
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
						{`Env${taskVarCount > 0 ? ` (${taskVarCount})` : ""}`}
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
