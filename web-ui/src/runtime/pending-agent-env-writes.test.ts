import type { AgentEnvConfig } from "@runtime-agent-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queueTaskEnvWrite, whenTaskEnvWriteSettled } from "@/runtime/pending-agent-env-writes";
import { fetchAgentEnvConfig, saveAgentEnvConfig } from "@/runtime/runtime-config-query";

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchAgentEnvConfig: vi.fn(),
	saveAgentEnvConfig: vi.fn(),
}));

const fetchMock = vi.mocked(fetchAgentEnvConfig);
const saveMock = vi.mocked(saveAgentEnvConfig);

// A mutable in-memory stand-in for the hub config so reads observe prior writes.
let current: AgentEnvConfig;

function clone(config: AgentEnvConfig): AgentEnvConfig {
	return structuredClone(config);
}

beforeEach(() => {
	current = { global: { G: "1" }, projects: { "proj-a": { P: "2" } }, tasks: {} };
	// A microtask delay makes the read-modify-write window observable, so a
	// non-serialized implementation would clobber concurrent writes.
	fetchMock.mockImplementation(async () => {
		await Promise.resolve();
		return clone(current);
	});
	saveMock.mockImplementation(async (config) => {
		current = clone(config);
		return clone(current);
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("queueTaskEnvWrite", () => {
	it("persists the task scope while preserving the other scopes", async () => {
		await queueTaskEnvWrite("task-1", { FOO: "bar" });
		expect(current.tasks["task-1"]).toEqual({ FOO: "bar" });
		expect(current.global).toEqual({ G: "1" });
		expect(current.projects).toEqual({ "proj-a": { P: "2" } });
	});

	it("removes the task scope when given an empty env", async () => {
		await queueTaskEnvWrite("task-1", { FOO: "bar" });
		await queueTaskEnvWrite("task-1", {});
		expect(current.tasks).toEqual({});
	});

	it("serializes concurrent writes so neither read-modify-write clobbers the other", async () => {
		await Promise.all([queueTaskEnvWrite("task-a", { A: "1" }), queueTaskEnvWrite("task-b", { B: "2" })]);
		expect(current.tasks).toEqual({ "task-a": { A: "1" }, "task-b": { B: "2" } });
	});

	it("keeps draining the queue after a failed write", async () => {
		saveMock.mockRejectedValueOnce(new Error("boom"));
		await expect(queueTaskEnvWrite("task-fail", { X: "1" })).rejects.toThrow("boom");
		await queueTaskEnvWrite("task-ok", { Y: "2" });
		expect(current.tasks).toEqual({ "task-ok": { Y: "2" } });
	});
});

describe("whenTaskEnvWriteSettled", () => {
	it("resolves only once the task's write has landed", async () => {
		let saved = false;
		saveMock.mockImplementationOnce(async (config) => {
			await Promise.resolve();
			current = clone(config);
			saved = true;
			return clone(current);
		});
		const write = queueTaskEnvWrite("task-1", { FOO: "bar" });
		await whenTaskEnvWriteSettled("task-1");
		expect(saved).toBe(true);
		await write;
	});

	it("resolves immediately when there is no pending write for the task", async () => {
		await expect(whenTaskEnvWriteSettled("unknown")).resolves.toBeUndefined();
	});

	it("does not reject even when the awaited write fails", async () => {
		saveMock.mockRejectedValueOnce(new Error("boom"));
		const write = queueTaskEnvWrite("task-fail", { X: "1" });
		await expect(whenTaskEnvWriteSettled("task-fail")).resolves.toBeUndefined();
		await expect(write).rejects.toThrow("boom");
	});
});
