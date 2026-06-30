import * as Popover from "@radix-ui/react-popover";
import type { AgentEnvConfig } from "@runtime-agent-env";
import { KeyRound } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";

import { type EnvRow, mapToRows, rowsToMap } from "@/components/agent-env/agent-env-rows";
import { EnvVarsEditor } from "@/components/agent-env/env-vars-editor";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fetchAgentEnvConfig, saveAgentEnvConfig } from "@/runtime/runtime-config-query";

interface TaskEnvButtonProps {
	taskId: string;
}

/**
 * Per-task custom env editor. Edits the task scope of the hub-central env config
 * (`tasks[taskId]`), which layers over the global and project scopes. Values
 * apply the next time the task session starts (the env is resolved at launch),
 * so changing them mid-run takes effect on restart.
 */
export function TaskEnvButton({ taskId }: TaskEnvButtonProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [config, setConfig] = useState<AgentEnvConfig | null>(null);
	const [rows, setRows] = useState<EnvRow[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

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

	const handleSave = (): void => {
		if (!config) {
			return;
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
		void saveAgentEnvConfig(nextConfig)
			.then((saved) => {
				setConfig(saved);
				setRows(mapToRows(saved.tasks[taskId] ?? {}));
				toast.success("Task environment saved");
				setOpen(false);
			})
			.catch(() => toast.error("Failed to save task environment"))
			.finally(() => setIsSaving(false));
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
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
							disabled={isSaving}
							emptyLabel="No task-specific variables. These override global and project vars."
						/>
					)}
					<p className="text-[11px] text-text-tertiary">
						Applied the next time this task starts. Layers over global and project variables.
					</p>
					<div className="flex justify-end">
						<Button variant="primary" size="sm" onClick={handleSave} disabled={isLoading || isSaving}>
							{isSaving ? "Saving…" : "Save"}
						</Button>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
