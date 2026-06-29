import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { listWorkspaceIndexEntries, loadWorkspaceState, saveWorkspaceState } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { removeTaskWorktreeSetupLock } from "../workspace/task-worktree";
import type { WorkspaceRegistry } from "./workspace-registry";

export interface RuntimeShutdownCoordinatorDependencies {
	workspaceRegistry: Pick<WorkspaceRegistry, "listManagedWorkspaces">;
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
	skipSessionCleanup?: boolean;
}

// Mark any sessions that were still running when the runtime stopped as "interrupted" so the UI
// shows them as resumable after a restart. Crucially this NEVER moves cards between columns and
// NEVER deletes worktrees: the board stays exactly as the user left it, and the worktree + the
// SDK-persisted conversation history are preserved so the agent session can be resumed in place.
async function persistInterruptedSessions(
	workspacePath: string,
	runningTaskIds: string[],
	options?: {
		workspaceState?: RuntimeWorkspaceStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	},
): Promise<void> {
	const workspaceState = options?.workspaceState ?? (await loadWorkspaceState(workspacePath));
	const taskIdsToInterrupt = new Set(runningTaskIds);
	// Also catch sessions that were left in a "running" state in persisted storage (e.g. native
	// Cline agents not tracked by the terminal manager, or a prior unclean shutdown).
	for (const [taskId, summary] of Object.entries(workspaceState.sessions)) {
		if (summary.state === "running") {
			taskIdsToInterrupt.add(taskId);
		}
	}
	if (taskIdsToInterrupt.size === 0) {
		return;
	}

	const nextSessions = {
		...workspaceState.sessions,
	};
	let changed = false;
	for (const taskId of taskIdsToInterrupt) {
		const summary = options?.resolveSummary?.(taskId) ?? workspaceState.sessions[taskId] ?? null;
		if (!summary || summary.state === "interrupted") {
			continue;
		}
		nextSessions[taskId] = {
			...summary,
			state: "interrupted",
			reviewReason: "interrupted",
			pid: null,
			updatedAt: Date.now(),
		};
		changed = true;
	}
	if (!changed) {
		return;
	}

	await saveWorkspaceState(workspacePath, {
		board: workspaceState.board,
		sessions: nextSessions,
	});
}

async function cleanupTaskWorktreeSetupLocks(
	repoPaths: Iterable<string>,
	warn: (message: string) => void,
): Promise<void> {
	await Promise.all(
		Array.from(new Set(repoPaths)).map(async (repoPath) => {
			try {
				await removeTaskWorktreeSetupLock(repoPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`Could not remove task worktree setup lock for ${repoPath} during shutdown cleanup. ${message}`);
			}
		}),
	);
}

function shouldInterruptSessionOnShutdown(summary: RuntimeTaskSessionSummary): boolean {
	// Only sessions that were actively running need to be downgraded to "interrupted". Tasks in
	// review (awaiting_review) have already finished their turn and must keep that state.
	return summary.state === "running";
}

function collectShutdownRunningTaskIds(
	interruptedSummaries: RuntimeTaskSessionSummary[],
	terminalManager: TerminalSessionManager,
): string[] {
	const taskIds = new Set(interruptedSummaries.map((summary) => summary.taskId));
	for (const summary of terminalManager.listSummaries()) {
		if (!shouldInterruptSessionOnShutdown(summary)) {
			continue;
		}
		taskIds.add(summary.taskId);
	}
	return Array.from(taskIds);
}

export async function shutdownRuntimeServer(deps: RuntimeShutdownCoordinatorDependencies): Promise<void> {
	if (deps.skipSessionCleanup) {
		await deps.closeRuntimeServer();
		return;
	}

	const interruptedByWorkspace: Array<{
		workspacePath: string;
		runningTaskIds: string[];
		workspaceState?: RuntimeWorkspaceStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	}> = [];
	const managedWorkspacePaths = new Set<string>();

	for (const { workspacePath, terminalManager } of deps.workspaceRegistry.listManagedWorkspaces()) {
		// Stop live PTY processes even though we no longer trash their tasks or delete worktrees.
		const interrupted = terminalManager.markInterruptedAndStopAll();
		const runningTaskIds = collectShutdownRunningTaskIds(interrupted, terminalManager);
		if (!workspacePath) {
			continue;
		}
		managedWorkspacePaths.add(workspacePath);
		try {
			const workspaceState = await loadWorkspaceState(workspacePath);
			interruptedByWorkspace.push({
				workspacePath,
				runningTaskIds,
				workspaceState,
				resolveSummary: (taskId) => terminalManager.getSummary(taskId),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load workspace state for ${workspacePath} during shutdown cleanup. ${message}`);
		}
	}

	const indexedWorkspaces = await listWorkspaceIndexEntries();
	for (const workspace of indexedWorkspaces) {
		if (managedWorkspacePaths.has(workspace.repoPath)) {
			continue;
		}
		try {
			const workspaceState = await loadWorkspaceState(workspace.repoPath);
			interruptedByWorkspace.push({
				workspacePath: workspace.repoPath,
				runningTaskIds: [],
				workspaceState,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load workspace state for ${workspace.repoPath} during shutdown cleanup. ${message}`);
		}
	}

	await Promise.all(
		interruptedByWorkspace.map(async (workspace) => {
			try {
				await persistInterruptedSessions(workspace.workspacePath, workspace.runningTaskIds, {
					workspaceState: workspace.workspaceState,
					resolveSummary: workspace.resolveSummary,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn(
					`Could not persist interrupted sessions for ${workspace.workspacePath} during shutdown. ${message}`,
				);
			}
		}),
	);

	await deps.closeRuntimeServer();

	await cleanupTaskWorktreeSetupLocks(
		[...managedWorkspacePaths, ...indexedWorkspaces.map((workspace) => workspace.repoPath)],
		deps.warn,
	);
}
