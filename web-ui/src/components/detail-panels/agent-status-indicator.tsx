import type { ReactElement } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TerminalConnectionStatus } from "@/terminal/persistent-terminal-manager";

type StatusTone = "neutral" | "success" | "warning" | "danger";

export interface AgentStatusDescriptor {
	/** Short agent-state label (Running / Ready for review / Crashed / …). */
	label: string;
	tone: StatusTone;
	/** Optional longer explanation surfaced as a tooltip (e.g. a crash warning). */
	detail: string | null;
}

const connectionDotColor: Record<TerminalConnectionStatus, string> = {
	connected: "bg-status-green",
	reconnecting: "bg-status-orange",
	disconnected: "bg-status-red",
};

const connectionDotLabel: Record<TerminalConnectionStatus, string> = {
	connected: "Connected",
	reconnecting: "Reconnecting…",
	disconnected: "Disconnected",
};

const toneClasses: Record<StatusTone, string> = {
	neutral: "bg-surface-3 text-text-secondary",
	success: "bg-status-green/15 text-status-green",
	warning: "bg-status-orange/15 text-status-orange",
	danger: "bg-status-red/15 text-status-red",
};

/**
 * Pure mapping from session summary -> a human agent-state label. Critically it
 * splits the single `awaiting_review` state apart by `reviewReason` so a *crash*
 * ("error") reads differently from a normal review-ready or a clean finish — the
 * cases that previously all rendered as an indistinguishable "Ready for review".
 */
export function describeAgentStatus(summary: RuntimeTaskSessionSummary | null): AgentStatusDescriptor {
	if (!summary) {
		return { label: "No session", tone: "neutral", detail: null };
	}
	const warning = summary.warningMessage ?? null;
	switch (summary.state) {
		case "running":
			return { label: "Running", tone: "success", detail: null };
		case "awaiting_review": {
			if (summary.reviewReason === "error" || warning) {
				return {
					label: "Crashed",
					tone: "danger",
					detail: warning ?? "The agent process exited unexpectedly. Restart to resume.",
				};
			}
			if (summary.reviewReason === "exit") {
				return { label: "Finished", tone: "neutral", detail: null };
			}
			return { label: "Ready for review", tone: "warning", detail: null };
		}
		case "interrupted":
			return { label: "Interrupted", tone: "danger", detail: warning };
		case "failed":
			return { label: "Failed", tone: "danger", detail: warning };
		default:
			return { label: "Idle", tone: "neutral", detail: warning };
	}
}

export interface AgentStatusIndicatorProps {
	summary: RuntimeTaskSessionSummary | null;
	connectionStatus: TerminalConnectionStatus;
}

/**
 * Compact, always-on status readout for an active agent terminal: a connection
 * dot (transport liveness) plus the agent-state pill. Lets the user tell at a
 * glance whether the connection dropped or the agent crashed — neither of which
 * was previously visible.
 */
export function AgentStatusIndicator({ summary, connectionStatus }: AgentStatusIndicatorProps): ReactElement {
	const status = describeAgentStatus(summary);
	const pill = (
		<span
			className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${toneClasses[status.tone]}`}
		>
			{status.label}
		</span>
	);
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<Tooltip side="top" content={connectionDotLabel[connectionStatus]}>
				<span
					role="status"
					aria-label={connectionDotLabel[connectionStatus]}
					className={`size-2 shrink-0 rounded-full ${connectionDotColor[connectionStatus]} ${
						connectionStatus === "reconnecting" ? "animate-pulse" : ""
					}`}
				/>
			</Tooltip>
			{status.detail ? (
				<Tooltip side="top" content={status.detail}>
					{pill}
				</Tooltip>
			) : (
				pill
			)}
		</div>
	);
}
