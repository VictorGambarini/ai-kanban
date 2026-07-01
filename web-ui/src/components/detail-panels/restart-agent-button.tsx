import { RotateCw } from "lucide-react";
import { type ReactElement, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export interface RestartAgentButtonProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	/** Re-spawns the agent process server-side; it resumes from its on-disk session. */
	onRestart: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Manual "Restart agent" control for an active CLI task. Re-spawns the PTY (the
 * agent resumes from its own persisted session), replacing the move-to-Done →
 * restore workaround people used when a connection silently broke. A running agent
 * is interrupted, so that case asks for confirmation first; a crashed/finished one
 * restarts immediately.
 */
export function RestartAgentButton({ taskId, summary, onRestart }: RestartAgentButtonProps): ReactElement {
	const [isRestarting, setIsRestarting] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const isRunning = summary?.state === "running";

	const runRestart = async () => {
		setIsRestarting(true);
		try {
			const result = await onRestart(taskId);
			if (result.ok) {
				toast.success("Agent restarting…");
			} else {
				toast.error(result.message ?? "Could not restart the agent.");
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not restart the agent.");
		} finally {
			setIsRestarting(false);
		}
	};

	const handleClick = () => {
		if (isRunning) {
			setConfirmOpen(true);
			return;
		}
		void runRestart();
	};

	return (
		<>
			<Tooltip side="top" content="Restart the agent process (resumes its session)">
				<Button
					variant="default"
					size="sm"
					icon={isRestarting ? <Spinner size={14} /> : <RotateCw size={14} />}
					disabled={isRestarting}
					onClick={handleClick}
				>
					Restart
				</Button>
			</Tooltip>
			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Restart the agent?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						The running agent process will be stopped and restarted. It resumes from its saved session, so no
						conversation history is lost — but any in-flight turn is interrupted.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default">Cancel</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							onClick={(event) => {
								event.preventDefault();
								setConfirmOpen(false);
								void runRestart();
							}}
						>
							Restart
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
