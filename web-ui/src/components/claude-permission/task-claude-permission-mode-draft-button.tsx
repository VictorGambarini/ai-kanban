import * as Popover from "@radix-ui/react-popover";
import type { ClaudePermissionStrategy } from "@runtime-claude-permission-strategy";
import { ShieldCheck } from "lucide-react";
import { type ReactElement, useState } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

interface TaskClaudePermissionModeDraftButtonProps {
	/** The strategy chosen so far for the not-yet-created task, or `null` for "use default". */
	value: ClaudePermissionStrategy | null;
	/** Commits the edited strategy back to the host (no persistence happens until the task is created). */
	onChange: (value: ClaudePermissionStrategy | null) => void;
	/** Notifies the host when the editor popover opens or closes. */
	onPopoverOpenChange?: (open: boolean) => void;
}

const USE_DEFAULT_VALUE = "__use_default__";

/**
 * Per-task Claude Code permission mode editor for the create flow, where no
 * task id exists yet. Unlike {@link TaskClaudePermissionModeButton} this keeps
 * the value purely in memory — the host persists it to the hub-central config
 * once the task is created and has an id.
 */
export function TaskClaudePermissionModeDraftButton({
	value,
	onChange,
	onPopoverOpenChange,
}: TaskClaudePermissionModeDraftButtonProps): ReactElement {
	const [open, setOpen] = useState(false);

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				onPopoverOpenChange?.(next);
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
					<NativeSelect
						value={value ?? USE_DEFAULT_VALUE}
						onChange={(event) =>
							onChange(
								event.target.value === USE_DEFAULT_VALUE
									? null
									: (event.target.value as ClaudePermissionStrategy),
							)
						}
					>
						<option value={USE_DEFAULT_VALUE}>Use project/global default</option>
						<option value="bypass">Bypass permissions</option>
						<option value="auto">Auto mode</option>
					</NativeSelect>
					<p className="text-[11px] text-text-tertiary">
						Applied when this task first starts. Overrides global and project defaults.
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
