import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";
import { setMaxLiveTerminalSessions } from "@/terminal/terminal-session-limit";

// Minimal globals so the real manager (xterm + sockets + observers) runs under jsdom.
class FakeWebSocket {
	static OPEN = 1;
	readyState = 1;
	binaryType = "arraybuffer";
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	constructor(public url: string) {}
	addEventListener() {}
	removeEventListener() {}
	send() {}
	close() {}
}

class FakeResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

const WORKSPACE = "ws-1";
const APPEARANCE = { cursorColor: "#fff", terminalBackgroundColor: "#000" };
const TASK_IDS = ["a", "b", "c", "d", "e"];

function ensure(taskId: string) {
	return ensurePersistentTerminal({ taskId, workspaceId: WORKSPACE, ...APPEARANCE });
}

beforeAll(() => {
	(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
	(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
});

describe("persistent terminal LRU eviction", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		for (const taskId of TASK_IDS) {
			disposePersistentTerminal(WORKSPACE, taskId);
		}
		window.localStorage.clear();
	});

	it("disposes the least-recently-used parked terminals once the cap is exceeded", () => {
		setMaxLiveTerminalSessions(2);

		const a = ensure("a");
		a.unmount(null);
		const b = ensure("b");
		b.unmount(null);
		const c = ensure("c"); // size would be 3 > cap 2 -> oldest ("a") evicted
		c.unmount(null);

		// Retained sessions return the same instance (checked first to avoid cascade).
		expect(ensure("c")).toBe(c);
		expect(ensure("b")).toBe(b);
		// The evicted session is rebuilt as a fresh instance.
		expect(ensure("a")).not.toBe(a);
	});

	it("never evicts the currently mounted (visible) terminal", () => {
		setMaxLiveTerminalSessions(2);

		const container = document.createElement("div");
		document.body.appendChild(container);

		const a = ensure("a");
		a.mount(container, APPEARANCE, { isVisible: false }); // a stays visible/mounted
		const b = ensure("b");
		b.unmount(null);
		const c = ensure("c"); // size 3 > cap 2 -> evict oldest *parked* ("b"); "a" is protected
		c.unmount(null);

		expect(ensure("a")).toBe(a); // mounted -> never evicted despite being oldest
		expect(ensure("c")).toBe(c);
		expect(ensure("b")).not.toBe(b); // parked LRU -> evicted

		a.unmount(container);
		container.remove();
	});
});
