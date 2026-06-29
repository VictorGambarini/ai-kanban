import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	clampMaxLiveTerminalSessions,
	DEFAULT_MAX_LIVE_TERMINAL_SESSIONS,
	getMaxLiveTerminalSessions,
	MAX_LIVE_TERMINAL_SESSIONS,
	MIN_LIVE_TERMINAL_SESSIONS,
	setMaxLiveTerminalSessions,
} from "@/terminal/terminal-session-limit";

describe("terminal-session-limit", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		window.localStorage.clear();
	});

	it("returns the default when nothing is stored", () => {
		expect(getMaxLiveTerminalSessions()).toBe(DEFAULT_MAX_LIVE_TERMINAL_SESSIONS);
	});

	it("returns the default for non-numeric stored values", () => {
		window.localStorage.setItem(LocalStorageKey.MaxLiveTerminalSessions, "not-a-number");
		expect(getMaxLiveTerminalSessions()).toBe(DEFAULT_MAX_LIVE_TERMINAL_SESSIONS);
	});

	it("clamps below the minimum and above the maximum", () => {
		expect(clampMaxLiveTerminalSessions(0)).toBe(MIN_LIVE_TERMINAL_SESSIONS);
		expect(clampMaxLiveTerminalSessions(-5)).toBe(MIN_LIVE_TERMINAL_SESSIONS);
		expect(clampMaxLiveTerminalSessions(10_000)).toBe(MAX_LIVE_TERMINAL_SESSIONS);
		expect(clampMaxLiveTerminalSessions(Number.NaN)).toBe(DEFAULT_MAX_LIVE_TERMINAL_SESSIONS);
		expect(clampMaxLiveTerminalSessions(3.6)).toBe(4);
	});

	it("round-trips a clamped value through localStorage", () => {
		setMaxLiveTerminalSessions(42);
		expect(getMaxLiveTerminalSessions()).toBe(42);

		setMaxLiveTerminalSessions(0);
		expect(getMaxLiveTerminalSessions()).toBe(MIN_LIVE_TERMINAL_SESSIONS);

		setMaxLiveTerminalSessions(99_999);
		expect(getMaxLiveTerminalSessions()).toBe(MAX_LIVE_TERMINAL_SESSIONS);
	});
});
