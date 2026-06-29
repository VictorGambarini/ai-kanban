import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

// Each live terminal session retains an xterm scrollback buffer, a WebGL
// renderer context, and two WebSockets. Without a ceiling the set of live
// terminals grows with every task a user opens, which is the dominant driver
// of the Kanban tab's runaway memory use. We cap how many stay resident and
// evict the least-recently-used ones; an evicted session is rebuilt from the
// server snapshot when reopened, so nothing is lost.
export const DEFAULT_MAX_LIVE_TERMINAL_SESSIONS = 20;

// Lower bound keeps at least the visible terminal alive. Upper bound is a
// generous guard for power users who deliberately raise the limit.
export const MIN_LIVE_TERMINAL_SESSIONS = 1;
export const MAX_LIVE_TERMINAL_SESSIONS = 200;

export function clampMaxLiveTerminalSessions(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_MAX_LIVE_TERMINAL_SESSIONS;
	}
	const rounded = Math.round(value);
	return Math.min(MAX_LIVE_TERMINAL_SESSIONS, Math.max(MIN_LIVE_TERMINAL_SESSIONS, rounded));
}

export function getMaxLiveTerminalSessions(): number {
	const raw = readLocalStorageItem(LocalStorageKey.MaxLiveTerminalSessions);
	if (raw === null || raw.trim().length === 0) {
		return DEFAULT_MAX_LIVE_TERMINAL_SESSIONS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) {
		return DEFAULT_MAX_LIVE_TERMINAL_SESSIONS;
	}
	return clampMaxLiveTerminalSessions(parsed);
}

export function setMaxLiveTerminalSessions(value: number): void {
	writeLocalStorageItem(LocalStorageKey.MaxLiveTerminalSessions, String(clampMaxLiveTerminalSessions(value)));
}
