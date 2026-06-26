import type { RuntimeAppRouter } from "@runtime-trpc";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { activeHostHeaders } from "@/runtime/active-host";

interface TrpcErrorDataWithConflictRevision {
	code?: string;
	conflictRevision?: number | null;
}

type RuntimeTrpcClient = ReturnType<typeof createTRPCProxyClient<RuntimeAppRouter>>;

const clientByWorkspaceId = new Map<string, RuntimeTrpcClient>();

export function getRuntimeTrpcClient(workspaceId: string | null): RuntimeTrpcClient {
	const key = workspaceId ?? "__unscoped__";
	const existing = clientByWorkspaceId.get(key);
	if (existing) {
		return existing;
	}
	const created = createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: "/api/trpc",
				// The active host is read per-request so a single cached client keeps
				// routing correctly to whichever host is selected.
				headers: () => ({
					...(workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
					...activeHostHeaders(),
				}),
			}),
		],
	});
	clientByWorkspaceId.set(key, created);
	return created;
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
