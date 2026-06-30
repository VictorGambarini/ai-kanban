import * as Popover from "@radix-ui/react-popover";
import type { AgentEnvMap } from "@runtime-agent-env";
import { KeyRound } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import { type EnvRow, mapToRows, rowsToMap } from "@/components/agent-env/agent-env-rows";
import { EnvVarsEditor } from "@/components/agent-env/env-vars-editor";
import { Button } from "@/components/ui/button";

interface TaskEnvDraftButtonProps {
	/** The env collected so far for the not-yet-created task. */
	value: AgentEnvMap;
	/** Commits edited variables back to the host (no persistence happens until the task is created). */
	onChange: (value: AgentEnvMap) => void;
	/** Notifies the host when the editor popover opens or closes. */
	onPopoverOpenChange?: (open: boolean) => void;
}

/**
 * Per-task env editor for the create flow, where no task id exists yet. Unlike
 * {@link TaskEnvButton} this keeps the values purely in memory — the host persists
 * them to the hub-central config once the task is created and has an id.
 */
export function TaskEnvDraftButton({ value, onChange, onPopoverOpenChange }: TaskEnvDraftButtonProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [rows, setRows] = useState<EnvRow[]>(() => mapToRows(value));

	// Reseed from the committed value when (re)opening so external resets — e.g.
	// after the task is created — are reflected without clobbering live edits.
	useEffect(() => {
		if (open) {
			setRows(mapToRows(value));
		}
		// `value` is intentionally omitted: reseeding mid-edit would drop empty rows.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	useEffect(() => {
		onPopoverOpenChange?.(open);
	}, [open, onPopoverOpenChange]);

	const handleRowsChange = (next: EnvRow[]): void => {
		setRows(next);
		onChange(rowsToMap(next));
	};

	const count = Object.keys(value).length;

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<Button
					variant="default"
					size="sm"
					icon={<KeyRound size={14} />}
					aria-label="Edit environment variables for this task"
				>
					{`Env${count > 0 ? ` (${count})` : ""}`}
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-50 flex max-h-[60vh] w-80 flex-col gap-2 overflow-y-auto rounded-md border border-border bg-surface-1 p-3 shadow-lg"
				>
					<span className="text-[12px] font-semibold text-text-primary">Task environment</span>
					<EnvVarsEditor
						rows={rows}
						onChange={handleRowsChange}
						emptyLabel="No task-specific variables. These override global and project vars."
					/>
					<p className="text-[11px] text-text-tertiary">
						Applied when this task first starts. Layers over global and project variables.
					</p>
					<div className="flex justify-end">
						<Button variant="primary" size="sm" onClick={() => setOpen(false)}>
							Done
						</Button>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
