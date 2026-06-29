import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { MOBILE_TOUCH_TARGET } from "@/components/ui/touch-target";
import { getTerminalController } from "@/terminal/terminal-controller-registry";

interface TerminalKey {
	id: string;
	label: ReactNode;
	ariaLabel: string;
	// Raw bytes written to the PTY, exactly as xterm would emit them for this key.
	sequence: string;
}

const ICON_SIZE = 16;

const KEYS: TerminalKey[] = [
	{ id: "left", label: <ArrowLeft size={ICON_SIZE} />, ariaLabel: "Left arrow", sequence: "\x1b[D" },
	{ id: "up", label: <ArrowUp size={ICON_SIZE} />, ariaLabel: "Up arrow", sequence: "\x1b[A" },
	{ id: "down", label: <ArrowDown size={ICON_SIZE} />, ariaLabel: "Down arrow", sequence: "\x1b[B" },
	{ id: "right", label: <ArrowRight size={ICON_SIZE} />, ariaLabel: "Right arrow", sequence: "\x1b[C" },
	{ id: "esc", label: "Esc", ariaLabel: "Escape", sequence: "\x1b" },
	{ id: "tab", label: "Tab", ariaLabel: "Tab", sequence: "\t" },
	{ id: "ctrl-c", label: "Ctrl+C", ariaLabel: "Control C", sequence: "\x03" },
	{ id: "enter", label: "Enter", ariaLabel: "Enter", sequence: "\r" },
];

export interface TerminalKeyBarProps {
	taskId: string;
}

/**
 * On-screen row of special keys (arrows, Esc, Tab, Ctrl+C, Enter) for touch
 * devices whose virtual keyboards lack them. Each tap writes the corresponding
 * raw byte sequence straight to the terminal PTY via the terminal controller.
 */
export function TerminalKeyBar({ taskId }: TerminalKeyBarProps): ReactElement {
	const sendKey = (sequence: string): void => {
		getTerminalController(taskId)?.input(sequence);
	};

	return (
		<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface-1 px-2 py-1">
			{KEYS.map((key) => (
				<Button
					key={key.id}
					variant="default"
					size="sm"
					className={cn("shrink-0", MOBILE_TOUCH_TARGET)}
					aria-label={key.ariaLabel}
					onClick={() => sendKey(key.sequence)}
				>
					{key.label}
				</Button>
			))}
		</div>
	);
}
