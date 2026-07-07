import type { RuntimeAppRouter } from "@runtime-trpc";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { hostHeadersForHostId, LOCAL_HOST_ID } from "@/runtime/active-host";
import { getTaskHostId } from "@/runtime/task-host-registry";

interface TrpcErrorDataWithConflictRevision {
	code?: string;
	conflictRevision?: number | null;
}

type RuntimeTrpcClient = ReturnType<typeof createTRPCProxyClient<RuntimeAppRouter>>;

const clientByKey = new Map<string, RuntimeTrpcClient>();

/**
 * A runtime tRPC client scoped to a workspace and a host. `hostId` defaults to the
 * hub (`LOCAL_HOST_ID`) because the board is hub-owned; per-task *execution* callers
 * pass an explicit host via {@link getRuntimeTrpcClientForTask} so different tasks
 * on one board reach their own runtimes. Batching means one HTTP request carries a
 * single host header, so clients are cached per (workspace, host) rather than
 * reading the host per-request.
 */
export function getRuntimeTrpcClient(workspaceId: string | null, hostId: string = LOCAL_HOST_ID): RuntimeTrpcClient {
	const key = `${workspaceId ?? "__unscoped__"}::${hostId}`;
	const existing = clientByKey.get(key);
	if (existing) {
		return existing;
	}
	const created = createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: "/api/trpc",
				headers: () => ({
					...(workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
					...hostHeadersForHostId(hostId),
				}),
			}),
		],
	});
	clientByKey.set(key, created);
	return created;
}

/**
 * The runtime client for a specific task's execution host (resolved from the
 * task→host registry). Use this for every per-task op — worktree ensure/delete,
 * start/stop/restart/input, chat — so it lands on the runtime that owns the task.
 */
export function getRuntimeTrpcClientForTask(workspaceId: string | null, taskId: string): RuntimeTrpcClient {
	return getRuntimeTrpcClient(workspaceId, getTaskHostId(taskId));
}

export function createWorkspaceTrpcClient(workspaceId: string): RuntimeTrpcClient {
	return getRuntimeTrpcClient(workspaceId);
}

let hubTrpcClient: RuntimeTrpcClient | null = null;

/**
 * A client that always targets the hub itself, never a remote host. Use this for
 * host management (`hosts.*`) so the switcher stays usable even while a remote
 * host is the active scope.
 */
export function getHubTrpcClient(): RuntimeTrpcClient {
	if (hubTrpcClient) {
		return hubTrpcClient;
	}
	hubTrpcClient = createTRPCProxyClient<RuntimeAppRouter>({
		links: [httpBatchLink({ url: "/api/trpc", headers: () => ({}) })],
	});
	return hubTrpcClient;
}

function readTrpcErrorData(error: TRPCClientError<RuntimeAppRouter>): TrpcErrorDataWithConflictRevision | null {
	const data = error.data as TrpcErrorDataWithConflictRevision | undefined;
	if (!data || typeof data !== "object") {
		return null;
	}
	return data;
}

export function readTrpcConflictRevision(error: unknown): number | null {
	if (!(error instanceof TRPCClientError)) {
		return null;
	}
	const data = readTrpcErrorData(error);
	if (data?.code !== "CONFLICT") {
		return null;
	}
	return typeof data.conflictRevision === "number" ? data.conflictRevision : null;
}
