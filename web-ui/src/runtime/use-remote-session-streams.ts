import { useEffect, useRef } from "react";

import { applyHostIdToUrl } from "@/runtime/active-host";
import type { RuntimeStateStreamMessage, RuntimeTaskSessionSummary } from "@/runtime/types";

const STREAM_RECONNECT_BASE_DELAY_MS = 500;
const STREAM_RECONNECT_MAX_DELAY_MS = 5_000;

/**
 * The board is hub-owned, but a task targeted at an SSH host runs on that host's
 * runtime — so its live session summaries (running → awaiting_review → interrupted,
 * which also drive the review-column reconcile) arrive on that host's state stream,
 * not the hub's. This hook fans out a lightweight state stream to each remote host
 * that owns a task and merges only the session summaries back in via
 * `onSessionSummaries`. Board/project state stays with the hub stream; terminal and
 * chat traffic route per-task elsewhere.
 */
export function useRemoteSessionStreams(input: {
	workspaceId: string | null;
	/** Distinct non-local host ids that currently own at least one task in this workspace. */
	remoteHostIds: string[];
	onSessionSummaries: (summaries: RuntimeTaskSessionSummary[]) => void;
}): void {
	const { workspaceId, remoteHostIds } = input;
	// Keep the handler in a ref so a new callback identity doesn't tear down sockets.
	const onSummariesRef = useRef(input.onSessionSummaries);
	onSummariesRef.current = input.onSessionSummaries;

	// Sort + join so the effect only re-runs when the *set* of hosts changes.
	const hostKey = [...remoteHostIds].sort().join(",");

	useEffect(() => {
		if (!workspaceId || hostKey.length === 0) {
			return;
		}
		const hostIds = hostKey.split(",");
		let cancelled = false;
		const sockets = new Map<string, WebSocket>();
		const timers = new Map<string, number>();
		const attempts = new Map<string, number>();

		const buildUrl = (hostId: string): string => {
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const url = new URL(`${protocol}//${window.location.host}/api/runtime/ws`);
			url.searchParams.set("workspaceId", workspaceId);
			applyHostIdToUrl(url, hostId);
			return url.toString();
		};

		const extractSummaries = (payload: RuntimeStateStreamMessage): RuntimeTaskSessionSummary[] => {
			if (payload.type === "snapshot") {
				return Object.values(payload.workspaceState?.sessions ?? {});
			}
			if (payload.type === "workspace_state_updated") {
				return payload.workspaceId === workspaceId ? Object.values(payload.workspaceState.sessions ?? {}) : [];
			}
			if (payload.type === "task_sessions_updated") {
				return payload.workspaceId === workspaceId ? payload.summaries : [];
			}
			return [];
		};

		const scheduleReconnect = (hostId: string) => {
			if (cancelled || timers.has(hostId)) {
				return;
			}
			const attempt = attempts.get(hostId) ?? 0;
			const delay = Math.min(STREAM_RECONNECT_MAX_DELAY_MS, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** attempt);
			attempts.set(hostId, attempt + 1);
			timers.set(
				hostId,
				window.setTimeout(() => {
					timers.delete(hostId);
					connect(hostId);
				}, delay),
			);
		};

		const connect = (hostId: string) => {
			if (cancelled) {
				return;
			}
			let socket: WebSocket;
			try {
				socket = new WebSocket(buildUrl(hostId));
			} catch {
				scheduleReconnect(hostId);
				return;
			}
			sockets.set(hostId, socket);
			socket.onopen = () => {
				attempts.set(hostId, 0);
			};
			socket.onmessage = (event) => {
				try {
					const payload = JSON.parse(String(event.data)) as RuntimeStateStreamMessage;
					const summaries = extractSummaries(payload);
					if (summaries.length > 0) {
						onSummariesRef.current(summaries);
					}
				} catch {
					// Ignore malformed stream messages.
				}
			};
			socket.onclose = () => {
				if (!cancelled) {
					scheduleReconnect(hostId);
				}
			};
			socket.onerror = () => {
				// `onclose` fires after `onerror`; reconnect is scheduled there.
			};
		};

		for (const hostId of hostIds) {
			connect(hostId);
		}

		return () => {
			cancelled = true;
			for (const timer of timers.values()) {
				window.clearTimeout(timer);
			}
			for (const socket of sockets.values()) {
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				socket.close();
			}
		};
	}, [workspaceId, hostKey]);
}
