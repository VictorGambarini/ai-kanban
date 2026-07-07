import type { ClaudePermissionStrategyConfig } from "@runtime-claude-permission-strategy";
import { describe, expect, it } from "vitest";

import {
	applyClaudePermissionStrategyScope,
	claudePermissionStrategyScopeKey,
	selectClaudePermissionStrategyScope,
} from "@/components/claude-permission/claude-permission-strategy-scope";

function config(): ClaudePermissionStrategyConfig {
	return {
		global: "bypass",
		projects: { p1: "auto" },
		tasks: { t1: "bypass" },
	};
}

describe("selectClaudePermissionStrategyScope", () => {
	it("reads each scope's stored value", () => {
		expect(selectClaudePermissionStrategyScope(config(), { kind: "global" })).toBe("bypass");
		expect(selectClaudePermissionStrategyScope(config(), { kind: "project", projectId: "p1" })).toBe("auto");
		expect(selectClaudePermissionStrategyScope(config(), { kind: "task", taskId: "t1" })).toBe("bypass");
	});

	it("returns null for an unset scope or a null project id", () => {
		expect(selectClaudePermissionStrategyScope(config(), { kind: "project", projectId: "missing" })).toBeNull();
		expect(selectClaudePermissionStrategyScope(config(), { kind: "project", projectId: null })).toBeNull();
		expect(selectClaudePermissionStrategyScope(config(), { kind: "task", taskId: "missing" })).toBeNull();
	});
});

describe("applyClaudePermissionStrategyScope", () => {
	it("writes a scope without touching the others", () => {
		const next = applyClaudePermissionStrategyScope(config(), { kind: "task", taskId: "t1" }, "auto");
		expect(next.tasks.t1).toBe("auto");
		expect(next.global).toBe("bypass");
		expect(next.projects).toEqual({ p1: "auto" });
	});

	it("deletes a project/task scope entry when the value is null", () => {
		expect(applyClaudePermissionStrategyScope(config(), { kind: "task", taskId: "t1" }, null).tasks).toEqual({});
		expect(applyClaudePermissionStrategyScope(config(), { kind: "project", projectId: "p1" }, null).projects).toEqual(
			{},
		);
	});

	it("clears the global scope to null", () => {
		expect(applyClaudePermissionStrategyScope(config(), { kind: "global" }, null).global).toBeNull();
	});

	it("is a no-op for a project scope with no id", () => {
		const base = config();
		expect(applyClaudePermissionStrategyScope(base, { kind: "project", projectId: null }, "auto")).toBe(base);
	});

	it("does not mutate the input config", () => {
		const base = config();
		applyClaudePermissionStrategyScope(base, { kind: "task", taskId: "t1" }, null);
		expect(base.tasks).toEqual({ t1: "bypass" });
	});
});

describe("claudePermissionStrategyScopeKey", () => {
	it("produces a stable string identity per scope", () => {
		expect(claudePermissionStrategyScopeKey({ kind: "global" })).toBe("global");
		expect(claudePermissionStrategyScopeKey({ kind: "project", projectId: "p1" })).toBe("project:p1");
		expect(claudePermissionStrategyScopeKey({ kind: "project", projectId: null })).toBe("project:");
		expect(claudePermissionStrategyScopeKey({ kind: "task", taskId: "t1" })).toBe("task:t1");
	});
});
