import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PersistedTerminalSnapshot, TerminalSnapshotStore } from "../../../src/terminal/terminal-snapshot-store";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

function createFakeSnapshotStore() {
	const data = new Map<string, PersistedTerminalSnapshot>();
	const save = vi.fn(async (taskId: string, snapshot: PersistedTerminalSnapshot) => {
		data.set(taskId, snapshot);
	});
	const load = vi.fn(async (taskId: string) => data.get(taskId) ?? null);
	const remove = vi.fn(async (taskId: string) => {
		data.delete(taskId);
	});
	const store: TerminalSnapshotStore = { load, save, remove };
	return { store, save, load, remove, data };
}

describe("TerminalSessionManager snapshot persistence", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("persists a snapshot on task-session exit containing prior output", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});
		const { store, save } = createFakeSnapshotStore();
		const manager = new TerminalSessionManager({ snapshotStore: store });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		spawnedSessions[0]?.triggerData("hello from the agent\r\n");
		spawnedSessions[0]?.triggerExit(0);

		await vi.waitFor(() => {
			expect(save).toHaveBeenCalled();
		});
		const [, persisted] = save.mock.calls.at(-1) ?? [];
		expect(persisted?.snapshot).toContain("hello from the agent");
	});

	it("does not write to the snapshot store for shell sessions", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});
		const { store, save } = createFakeSnapshotStore();
		const manager = new TerminalSessionManager({ snapshotStore: store });

		await manager.startShellSession({
			taskId: "shell-task-1",
			cwd: "/tmp/shell-task-1",
			binary: "/bin/bash",
		});
		spawnedSessions[0]?.triggerData("ls -la\r\n");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(save).not.toHaveBeenCalled();
	});

	it("persists the old session's output before disposing the mirror on restart", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});
		const { store, save } = createFakeSnapshotStore();
		const manager = new TerminalSessionManager({ snapshotStore: store });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		spawnedSessions[0]?.triggerData("output from the first session\r\n");

		// Simulate the trash->review fast round trip from AGENTS.md: the move-to-trash
		// stop is fired async and its exit event has not been observed yet (entry.active
		// is still set) when the resume-to-review restart arrives. startTaskSession's
		// own active-session guard only checks entry.active, so clearing it here
		// reproduces the race without needing to race a real PTY exit callback.
		const entries = (manager as unknown as { entries: Map<string, { active: unknown }> }).entries;
		const raceEntry = entries.get("task-1");
		if (raceEntry) {
			raceEntry.active = null;
		}

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			resumeFromTrash: true,
		});

		await vi.waitFor(() => {
			expect(save).toHaveBeenCalled();
		});
		const [, persisted] = save.mock.calls.at(-1) ?? [];
		expect(persisted?.snapshot).toContain("output from the first session");
	});

	it("returns the live mirror snapshot over a stale disk snapshot", async () => {
		const { store } = createFakeSnapshotStore();
		await store.save("task-restore", {
			version: 1,
			snapshot: "stale from disk",
			cols: 80,
			rows: 24,
			savedAt: 1,
			sessionStartedAt: null,
		});
		const manager = new TerminalSessionManager({ snapshotStore: store });
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "live from mirror",
			cols: 120,
			rows: 40,
			sequence: 3,
		}));
		const entry = {
			summary: { taskId: "task-restore", state: "running" },
			active: null,
			terminalStateMirror: { getSnapshot: getSnapshotSpy },
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot?.snapshot).toBe("live from mirror");
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});

	it("falls back to the disk snapshot when the entry's mirror is gone", async () => {
		const { store } = createFakeSnapshotStore();
		await store.save("task-restore", {
			version: 1,
			snapshot: "restored from disk",
			cols: 90,
			rows: 30,
			savedAt: 1,
			sessionStartedAt: null,
		});
		const manager = new TerminalSessionManager({ snapshotStore: store });
		manager.hydrateFromRecord({
			"task-restore": {
				taskId: "task-restore",
				state: "idle",
				agentId: "codex",
				workspacePath: null,
				pid: null,
				startedAt: null,
				updatedAt: Date.now(),
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			},
		});

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "restored from disk",
			cols: 90,
			rows: 30,
			sequence: 0,
		});
	});

	it("falls back to the disk snapshot when there is no entry at all", async () => {
		const { store } = createFakeSnapshotStore();
		await store.save("task-never-hydrated", {
			version: 1,
			snapshot: "restored without an entry",
			cols: 80,
			rows: 24,
			savedAt: 1,
			sessionStartedAt: null,
		});
		const manager = new TerminalSessionManager({ snapshotStore: store });

		const snapshot = await manager.getRestoreSnapshot("task-never-hydrated");

		expect(snapshot?.snapshot).toBe("restored without an entry");
	});

	it("debounces the crash-hardening flush to at most once per 30s of continuous output", async () => {
		vi.useFakeTimers();
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});
		const { store, save } = createFakeSnapshotStore();
		const manager = new TerminalSessionManager({ snapshotStore: store });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		spawnedSessions[0]?.triggerData("first chunk\r\n");
		await vi.advanceTimersByTimeAsync(10_000);
		spawnedSessions[0]?.triggerData("second chunk\r\n");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(save).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10_000);
		await vi.waitFor(
			() => {
				expect(save).toHaveBeenCalledTimes(1);
			},
			{ timeout: 5_000 },
		);
	});

	it("does not flush when there was no output", async () => {
		vi.useFakeTimers();
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});
		const { store, save } = createFakeSnapshotStore();
		const manager = new TerminalSessionManager({ snapshotStore: store });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		await vi.advanceTimersByTimeAsync(30_000);

		expect(save).not.toHaveBeenCalled();
	});

	it("clears the pending flush timer on exit", async () => {
		vi.useFakeTimers();
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});
		const { store, save } = createFakeSnapshotStore();
		const manager = new TerminalSessionManager({ snapshotStore: store });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		spawnedSessions[0]?.triggerData("some output\r\n");
		spawnedSessions[0]?.triggerExit(0);

		await vi.waitFor(() => {
			expect(save).toHaveBeenCalledTimes(1);
		});

		await vi.advanceTimersByTimeAsync(30_000);
		// The exit-time persist already ran; the debounce timer must not fire again.
		expect(save).toHaveBeenCalledTimes(1);
	});
});
