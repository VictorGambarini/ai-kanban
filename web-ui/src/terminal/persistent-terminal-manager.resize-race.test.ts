import { Terminal } from "@xterm/xterm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

// Regression coverage for the "uneven terminal columns after reopening a ticket" bug:
// a resize triggered while applyRestore() is still writing the scrollback snapshot
// used to run fit()/resize() synchronously, reflowing only the not-yet-processed part
// of the buffer to the new width. requestResize() now queues behind terminalWriteQueue
// so it can never run mid-write. Terminal.write is mocked so this test controls exactly
// when the in-flight restore write "completes", instead of racing real xterm/rAF timing.

interface FakeWebSocketInstance {
	url: string;
	sent: string[];
	onopen: (() => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: (() => void) | null;
	onclose: (() => void) | null;
}

let socketInstances: FakeWebSocketInstance[] = [];

class FakeWebSocket implements FakeWebSocketInstance {
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	static readonly CLOSED = 3;
	readonly OPEN = FakeWebSocket.OPEN;
	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	sent: string[] = [];
	url: string;

	constructor(url: string) {
		this.url = url;
		socketInstances.push(this);
	}

	addEventListener(): void {}
	removeEventListener(): void {}

	send(data: unknown): void {
		this.sent.push(typeof data === "string" ? data : String(data));
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}
}

let resizeObserverCallback: (() => void) | null = null;

class FakeResizeObserver {
	constructor(callback: () => void) {
		resizeObserverCallback = callback;
	}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

const WORKSPACE = "ws-resize-race";
const TASK_ID = "resize-race-task";
const APPEARANCE = { cursorColor: "#fff", terminalBackgroundColor: "#000" };

function findSocket(pathSegment: string): FakeWebSocketInstance {
	const socket = [...socketInstances].reverse().find((instance) => instance.url.includes(pathSegment));
	if (!socket) {
		throw new Error(`No fake socket found for ${pathSegment}`);
	}
	return socket;
}

function sentMessageTypes(socket: FakeWebSocketInstance): string[] {
	return socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

beforeAll(() => {
	(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
	(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
});

describe("persistent terminal resize/restore ordering", () => {
	let pendingWriteCallbacks: Array<() => void>;

	beforeEach(() => {
		socketInstances = [];
		resizeObserverCallback = null;
		pendingWriteCallbacks = [];
		// Replace real buffer writes with a fully manual queue: callbacks only fire when
		// the test releases them, so the "restore write still in flight" window is
		// deterministic instead of racing jsdom's rAF-driven xterm write scheduling.
		vi.spyOn(Terminal.prototype, "write").mockImplementation(function (
			this: Terminal,
			_data: string | Uint8Array,
			callback?: () => void,
		) {
			if (callback) {
				pendingWriteCallbacks.push(callback);
			}
		});
	});

	afterEach(() => {
		disposePersistentTerminal(WORKSPACE, TASK_ID);
		vi.restoreAllMocks();
	});

	it("does not resize the terminal until the in-flight restore write finishes", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const terminal = ensurePersistentTerminal({ taskId: TASK_ID, workspaceId: WORKSPACE, ...APPEARANCE });
		terminal.mount(container, APPEARANCE, { isVisible: false });

		const controlSocket = findSocket("/api/terminal/control");

		controlSocket.onmessage?.({
			data: JSON.stringify({ type: "restore", snapshot: "hello from scrollback", cols: 80, rows: 24 }),
		});
		// Let applyRestore's microtasks run up to (and including) its enqueueTerminalWrite
		// call, so the write is genuinely in flight (queued, callback held) before we probe.
		for (let attempt = 0; attempt < 20 && pendingWriteCallbacks.length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(pendingWriteCallbacks).toHaveLength(1);
		expect(resizeObserverCallback).not.toBeNull();

		// Fire a concurrent resize the way a mobile layout shift mid-restore would, and
		// let its 50ms debounce elapse. The restore write is still frozen at this point.
		resizeObserverCallback?.();
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(sentMessageTypes(controlSocket)).not.toContain("resize");
		expect(sentMessageTypes(controlSocket)).not.toContain("restore_complete");

		// Release the restore write.
		pendingWriteCallbacks.shift()?.();
		for (
			let attempt = 0;
			attempt < 20 && !sentMessageTypes(controlSocket).includes("restore_complete");
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		const types = sentMessageTypes(controlSocket);
		const restoreCompleteIndex = types.indexOf("restore_complete");
		const resizeIndex = types.indexOf("resize");

		expect(restoreCompleteIndex).toBeGreaterThanOrEqual(0);
		expect(resizeIndex).toBeGreaterThan(restoreCompleteIndex);

		terminal.unmount(container);
		container.remove();
	});
});
