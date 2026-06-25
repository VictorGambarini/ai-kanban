import * as Switch from "@radix-ui/react-switch";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";

interface SkillSwitchProps {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
	id?: string;
	className?: string;
}

/**
 * The shared on/off toggle used for skills, both in workspace settings (enable/disable)
 * and in the per-task Advanced tab (select/deselect). Keeps a single source of truth for
 * the toggle's appearance.
 */
export function SkillSwitch({ checked, disabled, onCheckedChange, id, className }: SkillSwitchProps): ReactElement {
	return (
		<Switch.Root
			id={id}
			checked={checked}
			disabled={disabled}
			onCheckedChange={onCheckedChange}
			className={cn(
				"relative h-4 w-7 flex-shrink-0 cursor-pointer rounded-full bg-surface-4 transition-colors data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
		>
			<Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[13px]" />
		</Switch.Root>
	);
}
