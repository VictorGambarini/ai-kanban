// Frontend facade for task-scoped runtime actions.
// It owns how the board and detail view start, stop, resize, and route task
// sessions across native Cline and PTY-backed agents.
import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError } from "@/components/app-toaster";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { type ClineChatActionResult, useClineChatRuntimeActions } from "@/hooks/use-cline-chat-runtime-actions";
import { resolveLaunchAgentEnv } from "@/runtime/agent-env-launch";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskChatMessage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "@/runtime/types";
import { trackTaskResumedFromTrash } from "@/telemetry/events";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { getTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard } from "@/types";

interface UseTaskSessionsInput {
	currentProjectId: string | null;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
}

interface EnsureTaskWorkspaceResult {
	ok: boolean;
	message?: string;
	response?: Extract<RuntimeWorktreeEnsureResponse, { ok: true }>;
}

interface SendTaskSessionInputResult {
	ok: boolean;
	message?: string;
}

interface StartTaskSessionResult {
	ok: boolean;
	message?: string;
}

interface StartTaskSessionOptions {
	resumeFromTrash?: boolean;
	// Resume an already-started task's agent from its on-disk session without
	// re-running the prompt (empty kickoff + the agent's own --continue/--resume).
	// Same wire behavior as resumeFromTrash, but not an actual trash restore — used
	// to fully re-spawn a task whose in-memory launch recipe was lost (e.g. after a
	// runtime restart), so it does not fire the trash-restore telemetry.
	resume?: boolean;
}

export interface UseTaskSessionsResult {
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;
	ensureTaskWorkspace: (task: BoardCard) => Promise<EnsureTaskWorkspaceResult>;
	startTaskSession: (task: BoardCard, options?: StartTaskSessionOptions) => Promise<StartTaskSessionResult>;
	stopTaskSession: (taskId: string) => Promise<void>;
	restartTaskSessionEnv: (taskId: string) => Promise<StartTaskSessionResult>;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<SendTaskSessionInputResult>;
	sendTaskChatMessage: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode },
	) => Promise<ClineChatActionResult>;
	abortTaskChatTurn: (taskId: string) => Promise<ClineChatActionResult>;
	cancelTaskChatTurn: (taskId: string) => Promise<ClineChatActionResult>;
	fetchTaskChatMessages: (taskId: string) => Promise<RuntimeTaskChatMessage[] | null>;
	cleanupTaskWorkspace: (taskId: string) => Promise<RuntimeWorktreeDeleteResponse | null>;
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
}

export function useTaskSessions({ currentProjectId, setSessions }: UseTaskSessionsInput): UseTaskSessionsResult {
	/*
		This merge needs to stay monotonic.

		We chased a nasty terminal bug where Home and Detail panes would appear to
		clear themselves right after starting a task or shell command. The actual
		sequence was:

		1. A new live session started and the terminal correctly saw a new startedAt.
		2. usePersistentTerminalSession reset the xterm instance for the new session.
		3. A stale summary from an older interrupted session was replayed back into
		   React state from workspace hydration or the persistent terminal cache.
		4. That older summary overwrote the newer running one.
		5. The UI then bounced between old and new session identities, causing extra
		   cleanup, remount, and reset cycles that looked like the terminal output
		   had vanished.

		Because of that, every task/session summary write here must prefer the
		newest summary and ignore older ones. If this ever becomes a plain
		last-write-wins assignment again, the "terminal randomly clears out"
		regression is very likely to come back.
	*/
	const upsertSession = useCallback(
		(summary: RuntimeTaskSessionSummary) => {
			setSessions((current) => {
				const previousSummary = current[summary.taskId] ?? null;
				const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
				if (newestSummary !== summary) {
					return current;
				}
				return {
					...current,
					[summary.taskId]: newestSummary,
				};
			});
		},
		[setSessions],
	);
	const {
		sendTaskChatMessage,
		loadTaskChatMessages: fetchTaskChatMessages,
		abortTaskChatTurn,
		cancelTaskChatTurn,
	} = useClineChatRuntimeActions({
		currentProjectId,
		onSessionSummary: upsertSession,
	});

	const ensureTaskWorkspace = useCallback(
		async (task: BoardCard): Promise<EnsureTaskWorkspaceResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.ensureWorktree.mutate({
					taskId: task.id,
					baseRef: task.baseRef,
				});
				if (!payload.ok) {
					return {
						ok: false,
						message: payload.error ?? "Worktree setup failed.",
					};
				}
				return { ok: true, response: payload };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId],
	);

	const startTaskSession = useCallback(
		async (task: BoardCard, options?: StartTaskSessionOptions): Promise<StartTaskSessionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				// A resume (trash restore or an in-place agent re-spawn) replays the agent's
				// own persisted session instead of re-running the prompt.
				// Send the flag only when actually resuming; keep it undefined otherwise so a
				// normal start's wire payload is unchanged (the server treats false/undefined
				// the same, but staying undefined avoids a spurious payload diff).
				const isResume = options?.resumeFromTrash === true || options?.resume === true ? true : undefined;
				const kickoffPrompt = isResume ? "" : task.prompt.trim();
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const geometry =
					getTerminalGeometry(task.id) ?? estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
				const env = await resolveLaunchAgentEnv({ projectId: currentProjectId, taskId: task.id });
				const payload = await trpcClient.runtime.startTaskSession.mutate({
					taskId: task.id,
					prompt: kickoffPrompt,
					taskTitle: task.title,
					images: isResume ? undefined : task.images,
					startInPlanMode: isResume ? undefined : task.startInPlanMode,
					resumeFromTrash: isResume,
					baseRef: task.baseRef,
					cols: geometry.cols,
					rows: geometry.rows,
					agentId: task.agentId,
					cliModel: task.cliModel,
					clineSettings: task.clineSettings,
					skillNames: task.skillNames,
					env,
				});
				if (!payload.ok || !payload.summary) {
					return {
						ok: false,
						message: payload.error ?? "Task session start failed.",
					};
				}
				upsertSession(payload.summary);
				if (options?.resumeFromTrash) {
					trackTaskResumedFromTrash();
				}
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSession],
	);

	const stopTaskSession = useCallback(
		async (taskId: string): Promise<void> => {
			if (!currentProjectId) {
				return;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				await trpcClient.runtime.stopTaskSession.mutate({ taskId });
			} catch {
				// Ignore stop errors during cleanup.
			}
		},
		[currentProjectId],
	);

	// Restart a running CLI agent so freshly-saved custom env applies (env is
	// injected at spawn). The runtime re-resolves the effective env itself, so we
	// only pass the taskId. The agent resumes from its persisted session.
	const restartTaskSessionEnv = useCallback(
		async (taskId: string): Promise<StartTaskSessionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.restartTaskSessionEnv.mutate({ taskId });
				if (!payload.ok) {
					return { ok: false, message: payload.error ?? "Could not restart the task." };
				}
				if (payload.summary) {
					upsertSession(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSession],
	);

	const sendTaskSessionInput = useCallback(
		async (taskId: string, text: string, options?: SendTerminalInputOptions): Promise<SendTaskSessionInputResult> => {
			const appendNewline = options?.appendNewline ?? true;
			const controller = options?.preferTerminal === false ? null : getTerminalController(taskId);
			if (controller) {
				const sent =
					options?.mode === "paste"
						? !appendNewline && controller.paste(text)
						: controller.input(appendNewline ? `${text}\n` : text);
				if (sent) {
					return { ok: true };
				}
			}
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.sendTaskSessionInput.mutate({
					taskId,
					text,
					appendNewline,
				});
				if (!payload.ok) {
					const errorMessage = payload.error || "Task session input failed.";
					return { ok: false, message: errorMessage };
				}
				if (payload.summary) {
					upsertSession(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSession],
	);

	const cleanupTaskWorkspace = useCallback(
		async (taskId: string): Promise<RuntimeWorktreeDeleteResponse | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.deleteWorktree.mutate({ taskId });
				if (!payload.ok) {
					const message = payload.error ?? "Could not clean up task workspace.";
					console.error(`[cleanupTaskWorkspace] ${message}`);
					return null;
				}
				return payload;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[cleanupTaskWorkspace] ${message}`);
				return null;
			}
		},
		[currentProjectId],
	);

	const fetchTaskWorkspaceInfo = useCallback(
		async (task: BoardCard): Promise<RuntimeTaskWorkspaceInfoResponse | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				return await trpcClient.workspace.getTaskContext.query({
					taskId: task.id,
					baseRef: task.baseRef,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return null;
			}
		},
		[currentProjectId],
	);

	return {
		upsertSession,
		ensureTaskWorkspace,
		startTaskSession,
		stopTaskSession,
		restartTaskSessionEnv,
		sendTaskSessionInput,
		sendTaskChatMessage,
		abortTaskChatTurn,
		cancelTaskChatTurn,
		fetchTaskChatMessages,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	};
}
