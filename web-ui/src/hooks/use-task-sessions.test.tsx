import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskSessions } from "@/hooks/use-task-sessions";
import type { BoardCard } from "@/types";

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const stopTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const deleteWorktreeMutateMock = vi.hoisted(() => vi.fn());
const trackTaskResumedFromTrashMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
const dismissAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			startTaskSession: {
				mutate: startTaskSessionMutateMock,
			},
			stopTaskSession: {
				mutate: stopTaskSessionMutateMock,
			},
		},
		workspace: {
			deleteWorktree: {
				mutate: deleteWorktreeMutateMock,
			},
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
	dismissAppToast: dismissAppToastMock,
}));

vi.mock("@/runtime/task-session-geometry", () => ({
	estimateTaskSessionGeometry: () => ({ cols: 120, rows: 40 }),
}));

vi.mock("@/telemetry/events", () => ({
	trackTaskResumedFromTrash: trackTaskResumedFromTrashMock,
}));

interface HookSnapshot {
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
	stopTaskSession: ReturnType<typeof useTaskSessions>["stopTaskSession"];
	cleanupTaskWorkspace: ReturnType<typeof useTaskSessions>["cleanupTaskWorkspace"];
}

function createTask(): BoardCard {
	return {
		id: "task-1",
		title: "Resume me",
		prompt: "Resume me",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function HookHarness({ onSnapshot }: { onSnapshot: (snapshot: HookSnapshot) => void }): null {
	const sessions = useTaskSessions({
		currentProjectId: "project-1",
		setSessions: () => {},
	});

	useEffect(() => {
		onSnapshot({
			startTaskSession: sessions.startTaskSession,
			stopTaskSession: sessions.stopTaskSession,
			cleanupTaskWorkspace: sessions.cleanupTaskWorkspace,
		});
	}, [onSnapshot, sessions.startTaskSession, sessions.stopTaskSession, sessions.cleanupTaskWorkspace]);

	return null;
}

describe("useTaskSessions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		startTaskSessionMutateMock.mockReset();
		stopTaskSessionMutateMock.mockReset();
		deleteWorktreeMutateMock.mockReset();
		trackTaskResumedFromTrashMock.mockReset();
		notifyErrorMock.mockReset();
		showAppToastMock.mockReset();
		dismissAppToastMock.mockReset();
		startTaskSessionMutateMock.mockResolvedValue({
			ok: true,
			summary: {
				taskId: "task-1",
				state: "running",
				agentId: "codex",
				workspacePath: "/tmp/task-1",
				pid: 123,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			},
		});
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderHookSnapshot(): Promise<HookSnapshot> {
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		return latestSnapshot;
	}

	it("tracks successful resume-from-trash starts", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask(), { resumeFromTrash: true });
		});

		expect(trackTaskResumedFromTrashMock).toHaveBeenCalledTimes(1);
	});

	it("does not track regular task starts", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask());
		});

		expect(trackTaskResumedFromTrashMock).not.toHaveBeenCalled();
	});

	it("forwards start-in-plan-mode from the task card when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				startInPlanMode: true,
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			prompt: "Resume me",
			taskTitle: "Resume me",
			images: undefined,
			startInPlanMode: true,
			resumeFromTrash: undefined,
			baseRef: "main",
			cols: 120,
			rows: 40,
			agentId: undefined,
			clineSettings: undefined,
		});
	});

	it("forwards task images when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			}),
		);
	});

	it("forwards task-level Cline reasoning effort overrides when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				agentId: "cline",
				clineSettings: {
					providerId: "openrouter",
					modelId: "anthropic/claude-opus-4.6",
					reasoningEffort: "low",
				},
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				clineSettings: {
					providerId: "openrouter",
					modelId: "anthropic/claude-opus-4.6",
					reasoningEffort: "low",
				},
			}),
		);
	});

	it("forwards reasoning-only overrides even when provider/model remain inherited", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				clineSettings: {
					reasoningEffort: "high",
				},
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				clineSettings: {
					reasoningEffort: "high",
				},
			}),
		);
	});

	describe("stopTaskSession", () => {
		it("does not notify when there was nothing running to stop", async () => {
			stopTaskSessionMutateMock.mockResolvedValue({ ok: false, summary: null });
			const snapshot = await renderHookSnapshot();

			await snapshot.stopTaskSession("task-1", "My Task");

			expect(notifyErrorMock).not.toHaveBeenCalled();
		});

		it("notifies with the task title when stop fails with an error", async () => {
			stopTaskSessionMutateMock.mockResolvedValue({ ok: false, summary: null, error: "boom" });
			const snapshot = await renderHookSnapshot();

			await snapshot.stopTaskSession("task-1", "My Task");

			expect(notifyErrorMock).toHaveBeenCalledTimes(1);
			const [message, options] = notifyErrorMock.mock.calls[0]!;
			expect(message).toContain("My Task");
			expect(options).toMatchObject({ key: "stop-failed:task-1" });
		});

		it("notifies when stop throws", async () => {
			stopTaskSessionMutateMock.mockRejectedValue(new Error("network down"));
			const snapshot = await renderHookSnapshot();

			await snapshot.stopTaskSession("task-1", "My Task");

			expect(notifyErrorMock).toHaveBeenCalledTimes(1);
			expect(notifyErrorMock.mock.calls[0]![1]).toMatchObject({ key: "stop-failed:task-1" });
		});
	});

	describe("cleanupTaskWorkspace", () => {
		it("does not notify on successful cleanup", async () => {
			deleteWorktreeMutateMock.mockResolvedValue({ ok: true, removed: true });
			const snapshot = await renderHookSnapshot();

			const result = await snapshot.cleanupTaskWorkspace("task-1", "My Task");

			expect(result).toEqual({ ok: true, removed: true });
			expect(notifyErrorMock).not.toHaveBeenCalled();
		});

		it("notifies with a retry action when cleanup fails, using the task title", async () => {
			deleteWorktreeMutateMock.mockResolvedValue({ ok: false, removed: false, error: "boom" });
			const snapshot = await renderHookSnapshot();

			const result = await snapshot.cleanupTaskWorkspace("task-1", "My Task");

			expect(result).toBeNull();
			expect(notifyErrorMock).toHaveBeenCalledTimes(1);
			const [message, options] = notifyErrorMock.mock.calls[0]!;
			expect(message).toContain("My Task");
			expect(options).toMatchObject({ key: "cleanup-failed:task-1", timeout: 20000 });
			expect(options.action.label).toBe("Retry");
		});

		it("falls back to a truncated task id when no title is given", async () => {
			deleteWorktreeMutateMock.mockResolvedValue({ ok: false, removed: false, error: "boom" });
			const snapshot = await renderHookSnapshot();

			await snapshot.cleanupTaskWorkspace("task-1234567890");

			expect(notifyErrorMock.mock.calls[0]![0]).toContain("task-1234567890".slice(0, 8));
		});

		it("notifies when cleanup throws", async () => {
			deleteWorktreeMutateMock.mockRejectedValue(new Error("network down"));
			const snapshot = await renderHookSnapshot();

			const result = await snapshot.cleanupTaskWorkspace("task-1", "My Task");

			expect(result).toBeNull();
			expect(notifyErrorMock).toHaveBeenCalledTimes(1);
		});

		it("dismisses the toast and confirms success when retry succeeds", async () => {
			deleteWorktreeMutateMock
				.mockResolvedValueOnce({ ok: false, removed: false, error: "boom" })
				.mockResolvedValueOnce({ ok: true, removed: true });
			const snapshot = await renderHookSnapshot();

			await snapshot.cleanupTaskWorkspace("task-1", "My Task");
			const options = notifyErrorMock.mock.calls[0]![1];

			await act(async () => {
				options.action.onClick();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			expect(deleteWorktreeMutateMock).toHaveBeenCalledTimes(2);
			expect(dismissAppToastMock).toHaveBeenCalledWith("cleanup-failed:task-1");
			expect(showAppToastMock).toHaveBeenCalledWith(
				expect.objectContaining({ intent: "success", message: expect.stringContaining("My Task") }),
			);
		});

		it("refreshes the same toast key when retry fails again", async () => {
			deleteWorktreeMutateMock
				.mockResolvedValueOnce({ ok: false, removed: false, error: "boom" })
				.mockResolvedValueOnce({ ok: false, removed: false, error: "boom again" });
			const snapshot = await renderHookSnapshot();

			await snapshot.cleanupTaskWorkspace("task-1", "My Task");
			const options = notifyErrorMock.mock.calls[0]![1];

			await act(async () => {
				options.action.onClick();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			expect(notifyErrorMock).toHaveBeenCalledTimes(2);
			expect(notifyErrorMock.mock.calls[1]![1]).toMatchObject({ key: "cleanup-failed:task-1" });
			expect(dismissAppToastMock).not.toHaveBeenCalled();
			expect(showAppToastMock).not.toHaveBeenCalled();
		});
	});
});
