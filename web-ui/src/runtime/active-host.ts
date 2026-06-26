import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";

/**
 * The "host" is the machine an agent runs on. `"local"` is the hub itself; any
 * other id is a remote host ("van") the hub reaches over SSH. The active host is
 * a scope *above* the workspace/project: it's threaded into every runtime
 * request (the `x-kanban-host-id` header) and WebSocket (the `hostId` query) so
 * the hub proxies that traffic to the selected machine.
 *
 * Because switching machines re-scopes the entire app (projects, board,
 * terminals), we persist the choice and reload — the same clean re-scope the
 * passcode gate uses on auth — rather than trying to live-migrate every stream.
 */
export const LOCAL_HOST_ID = "local";

function readPersistedHostId(): string {
	const stored = readLocalStorageItem(LocalStorageKey.ActiveHostId);
	return stored?.trim() ? stored.trim() : LOCAL_HOST_ID;
}

let activeHostId = typeof window === "undefined" ? LOCAL_HOST_ID : readPersistedHostId();

export function getActiveHostId(): string {
	return activeHostId;
}

export function isLocalActiveHost(): boolean {
	return activeHostId === LOCAL_HOST_ID;
}

/**
 * Persist the selected host and reload to re-scope the app. No-op when the id is
 * unchanged. Exposed `reload` is injectable for tests.
 */
export function setActiveHostId(hostId: string, reload: () => void = () => window.location.reload()): void {
	const next = hostId.trim() || LOCAL_HOST_ID;
	if (next === activeHostId) {
		return;
	}
	if (next === LOCAL_HOST_ID) {
		removeLocalStorageItem(LocalStorageKey.ActiveHostId);
	} else {
		writeLocalStorageItem(LocalStorageKey.ActiveHostId, next);
	}
	activeHostId = next;
	reload();
}

/** Headers to attach to a runtime request for the active host (empty when local). */
export function activeHostHeaders(): Record<string, string> {
	return isLocalActiveHost() ? {} : { "x-kanban-host-id": activeHostId };
}

/** Append the active host id to a WebSocket URL when targeting a remote host. */
export function applyActiveHostToUrl(url: URL): void {
	if (!isLocalActiveHost()) {
		url.searchParams.set("hostId", activeHostId);
	}
}
