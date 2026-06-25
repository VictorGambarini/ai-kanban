import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";

/** Small "NEW" pill shown on recently-installed skills. */
export function SkillNewBadge({ className }: { className?: string }): ReactElement {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-sm bg-status-blue/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-status-blue",
				className,
			)}
		>
			New
		</span>
	);
}
