import { describe, expect, it } from "vitest";

import {
	DEFAULT_CLAUDE_PERMISSION_STRATEGY,
	isClaudePermissionStrategyConfigEmpty,
	normalizeClaudePermissionStrategy,
	normalizeClaudePermissionStrategyConfig,
	resolveEffectiveClaudePermissionStrategy,
} from "../../../src/core/claude-permission-strategy";

describe("normalizeClaudePermissionStrategy", () => {
	it("accepts known values", () => {
		expect(normalizeClaudePermissionStrategy("bypass")).toBe("bypass");
		expect(normalizeClaudePermissionStrategy("auto")).toBe("auto");
	});

	it("rejects unknown values", () => {
		expect(normalizeClaudePermissionStrategy("yolo")).toBeNull();
		expect(normalizeClaudePermissionStrategy(null)).toBeNull();
		expect(normalizeClaudePermissionStrategy(undefined)).toBeNull();
		expect(normalizeClaudePermissionStrategy(42)).toBeNull();
	});
});

describe("normalizeClaudePermissionStrategyConfig", () => {
	it("normalizes every scope and drops invalid per-scope values", () => {
		const config = normalizeClaudePermissionStrategyConfig({
			global: "auto",
			projects: { "proj-a": "bypass", "proj-bad": "yolo" },
			tasks: { "task-1": "auto" },
			junk: true,
		});
		expect(config.global).toBe("auto");
		expect(config.projects).toEqual({ "proj-a": "bypass" });
		expect(config.projects).not.toHaveProperty("proj-bad");
		expect(config.tasks).toEqual({ "task-1": "auto" });
	});

	it("returns the empty shape for malformed input", () => {
		expect(normalizeClaudePermissionStrategyConfig(undefined)).toEqual({ global: null, projects: {}, tasks: {} });
	});
});

describe("resolveEffectiveClaudePermissionStrategy", () => {
	const config = normalizeClaudePermissionStrategyConfig({
		global: "auto",
		projects: { "proj-a": "bypass" },
		tasks: { "task-1": "auto" },
	});

	it("task scope wins over project and global", () => {
		expect(resolveEffectiveClaudePermissionStrategy(config, { projectId: "proj-a", taskId: "task-1" })).toBe("auto");
	});

	it("project scope wins over global when no task override", () => {
		expect(resolveEffectiveClaudePermissionStrategy(config, { projectId: "proj-a" })).toBe("bypass");
	});

	it("falls back to global when project/task scopes are absent", () => {
		expect(resolveEffectiveClaudePermissionStrategy(config, {})).toBe("auto");
	});

	it("ignores unknown project/task ids", () => {
		expect(resolveEffectiveClaudePermissionStrategy(config, { projectId: "missing", taskId: "missing" })).toBe(
			"auto",
		);
	});

	it("falls back to the default when nothing is set anywhere", () => {
		const empty = normalizeClaudePermissionStrategyConfig(undefined);
		expect(resolveEffectiveClaudePermissionStrategy(empty, { projectId: "proj-a", taskId: "task-1" })).toBe(
			DEFAULT_CLAUDE_PERMISSION_STRATEGY,
		);
	});
});

describe("isClaudePermissionStrategyConfigEmpty", () => {
	it("detects empty and non-empty configs", () => {
		expect(isClaudePermissionStrategyConfigEmpty(normalizeClaudePermissionStrategyConfig({}))).toBe(true);
		expect(isClaudePermissionStrategyConfigEmpty(normalizeClaudePermissionStrategyConfig({ global: "auto" }))).toBe(
			false,
		);
		expect(
			isClaudePermissionStrategyConfigEmpty(
				normalizeClaudePermissionStrategyConfig({ tasks: { "task-1": "bypass" } }),
			),
		).toBe(false);
	});
});
