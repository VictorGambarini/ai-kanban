import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

// Regression coverage for the Done/trash read-only terminal (issue #30): a read-only
// session must never forward user keystrokes/paste to the PTY, while the restore /
// resize / heartbeat protocol traffic that the live view depends on keeps flowing.

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

class FakeResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

const WORKSPACE = "ws-read-only";
const TASK_ID = "read-only-task";
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

async function flushMicrotasks(): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

beforeAll(() => {
	(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
	(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
});

describe("persistent terminal read-only mode", () => {
	beforeEach(() => {
		socketInstances = [];
	});

	afterEach(() => {
		disposePersistentTerminal(WORKSPACE, TASK_ID);
		vi.restoreAllMocks();
	});

	it("suppresses input and paste while read-only but keeps protocol traffic flowing", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const terminal = ensurePersistentTerminal({ taskId: TASK_ID, workspaceId: WORKSPACE, ...APPEARANCE });
		terminal.mount(container, APPEARANCE, { isVisible: false });
		terminal.setReadOnly(true);

		const ioSocket = findSocket("/api/terminal/io");
		const controlSocket = findSocket("/api/terminal/control");

		expect(terminal.input("hello")).toBe(false);
		expect(terminal.paste("pasted text")).toBe(false);
		expect(ioSocket.sent).toHaveLength(0);

		controlSocket.onmessage?.({
			data: JSON.stringify({ type: "restore", snapshot: "", cols: 80, rows: 24 }),
		});
		await flushMicrotasks();

		expect(sentMessageTypes(controlSocket)).toContain("restore_complete");
		// Mounting/restoring triggers a resize; read-only must not block protocol sends.
		expect(sentMessageTypes(controlSocket)).toContain("resize");

		terminal.unmount(container);
		container.remove();
	});

	it("restores input once read-only is cleared", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const terminal = ensurePersistentTerminal({ taskId: TASK_ID, workspaceId: WORKSPACE, ...APPEARANCE });
		terminal.mount(container, APPEARANCE, { isVisible: false });
		terminal.setReadOnly(true);
		expect(terminal.input("hello")).toBe(false);

		const ioSocket = findSocket("/api/terminal/io");
		expect(ioSocket.sent).toHaveLength(0);

		terminal.setReadOnly(false);
		expect(terminal.input("hello")).toBe(true);
		expect(ioSocket.sent.length).toBeGreaterThan(0);

		terminal.unmount(container);
		container.remove();
	});

	it("reports whether the restored snapshot had content", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const terminal = ensurePersistentTerminal({ taskId: TASK_ID, workspaceId: WORKSPACE, ...APPEARANCE });
		terminal.mount(container, APPEARANCE, { isVisible: false });

		const controlSocket = findSocket("/api/terminal/control");
		const restoreResults: boolean[] = [];
		const unsubscribe = terminal.subscribe({
			onRestoreResult: (hasContent) => {
				restoreResults.push(hasContent);
			},
		});

		controlSocket.onmessage?.({
			data: JSON.stringify({ type: "restore", snapshot: "", cols: 80, rows: 24 }),
		});
		await flushMicrotasks();
		expect(restoreResults).toEqual([false]);

		controlSocket.onmessage?.({
			data: JSON.stringify({ type: "restore", snapshot: "hello from scrollback", cols: 80, rows: 24 }),
		});
		await flushMicrotasks();
		expect(restoreResults).toEqual([false, true]);

		unsubscribe();
		terminal.unmount(container);
		container.remove();
	});
});
