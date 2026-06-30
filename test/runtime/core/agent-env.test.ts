import { describe, expect, it } from "vitest";

import {
	isAgentEnvConfigEmpty,
	isValidEnvKey,
	normalizeAgentEnvConfig,
	normalizeAgentEnvMap,
	REDACTED_ENV_VALUE,
	redactAgentEnvMap,
	resolveEffectiveAgentEnv,
} from "../../../src/core/agent-env";

describe("isValidEnvKey", () => {
	it("accepts POSIX-style names", () => {
		expect(isValidEnvKey("GH_TOKEN")).toBe(true);
		expect(isValidEnvKey("_PRIVATE")).toBe(true);
		expect(isValidEnvKey("JIRA_API_KEY2")).toBe(true);
	});

	it("rejects names with illegal characters or leading digits", () => {
		expect(isValidEnvKey("2FA")).toBe(false);
		expect(isValidEnvKey("GH-TOKEN")).toBe(false);
		expect(isValidEnvKey("HAS SPACE")).toBe(false);
		expect(isValidEnvKey("")).toBe(false);
	});
});

describe("normalizeAgentEnvMap", () => {
	it("trims keys, drops invalid keys, and coerces values to strings", () => {
		const result = normalizeAgentEnvMap({
			"  GH_TOKEN  ": "abc",
			"BAD-KEY": "x",
			EMPTY: "",
			COUNT: 42,
			NIL: null,
		});
		expect(result).toEqual({ GH_TOKEN: "abc", EMPTY: "", COUNT: "42" });
		expect(result).not.toHaveProperty("BAD-KEY");
		expect(result).not.toHaveProperty("NIL");
	});

	it("preserves meaningful whitespace in values", () => {
		expect(normalizeAgentEnvMap({ TOKEN: " spaced " })).toEqual({ TOKEN: " spaced " });
	});

	it("returns an empty object for non-object input", () => {
		expect(normalizeAgentEnvMap(null)).toEqual({});
		expect(normalizeAgentEnvMap(["x"])).toEqual({});
		expect(normalizeAgentEnvMap("str")).toEqual({});
	});
});

describe("normalizeAgentEnvConfig", () => {
	it("normalizes every scope and drops empty per-scope maps", () => {
		const config = normalizeAgentEnvConfig({
			global: { GLOBAL: "1", "BAD KEY": "x" },
			projects: { "proj-a": { PROJ: "2" }, "proj-empty": { "BAD-": "x" } },
			tasks: { "task-1": { TASK: "3" } },
			junk: true,
		});
		expect(config.global).toEqual({ GLOBAL: "1" });
		expect(config.projects).toEqual({ "proj-a": { PROJ: "2" } });
		expect(config.projects).not.toHaveProperty("proj-empty");
		expect(config.tasks).toEqual({ "task-1": { TASK: "3" } });
	});

	it("returns the empty shape for malformed input", () => {
		expect(normalizeAgentEnvConfig(undefined)).toEqual({ global: {}, projects: {}, tasks: {} });
	});
});

describe("resolveEffectiveAgentEnv", () => {
	const config = normalizeAgentEnvConfig({
		global: { SHARED: "global", GLOBAL_ONLY: "g" },
		projects: { "proj-a": { SHARED: "project", PROJECT_ONLY: "p" } },
		tasks: { "task-1": { SHARED: "task", TASK_ONLY: "t" } },
	});

	it("layers task over project over global", () => {
		expect(resolveEffectiveAgentEnv(config, { projectId: "proj-a", taskId: "task-1" })).toEqual({
			SHARED: "task",
			GLOBAL_ONLY: "g",
			PROJECT_ONLY: "p",
			TASK_ONLY: "t",
		});
	});

	it("falls back to global when project/task scopes are absent", () => {
		expect(resolveEffectiveAgentEnv(config, {})).toEqual({ SHARED: "global", GLOBAL_ONLY: "g" });
	});

	it("ignores unknown project/task ids", () => {
		expect(resolveEffectiveAgentEnv(config, { projectId: "missing", taskId: "missing" })).toEqual({
			SHARED: "global",
			GLOBAL_ONLY: "g",
		});
	});
});

describe("isAgentEnvConfigEmpty", () => {
	it("detects empty and non-empty configs", () => {
		expect(isAgentEnvConfigEmpty(normalizeAgentEnvConfig({}))).toBe(true);
		expect(isAgentEnvConfigEmpty(normalizeAgentEnvConfig({ global: { A: "1" } }))).toBe(false);
	});
});

describe("redactAgentEnvMap", () => {
	it("masks values while keeping keys", () => {
		expect(redactAgentEnvMap({ GH_TOKEN: "secret", JIRA: "k" })).toEqual({
			GH_TOKEN: REDACTED_ENV_VALUE,
			JIRA: REDACTED_ENV_VALUE,
		});
	});
});
