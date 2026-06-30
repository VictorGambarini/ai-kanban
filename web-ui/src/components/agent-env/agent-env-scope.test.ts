import type { AgentEnvConfig } from "@runtime-agent-env";
import { describe, expect, it } from "vitest";

import {
	agentEnvMapsEqual,
	agentEnvScopeKey,
	applyAgentEnvScope,
	selectAgentEnvScope,
} from "@/components/agent-env/agent-env-scope";

function config(): AgentEnvConfig {
	return {
		global: { A: "1" },
		projects: { p1: { B: "2" } },
		tasks: { t1: { C: "3" } },
	};
}

describe("selectAgentEnvScope", () => {
	it("reads each scope's map", () => {
		expect(selectAgentEnvScope(config(), { kind: "global" })).toEqual({ A: "1" });
		expect(selectAgentEnvScope(config(), { kind: "project", projectId: "p1" })).toEqual({ B: "2" });
		expect(selectAgentEnvScope(config(), { kind: "task", taskId: "t1" })).toEqual({ C: "3" });
	});

	it("returns an empty map for an unset scope or a null project id", () => {
		expect(selectAgentEnvScope(config(), { kind: "project", projectId: "missing" })).toEqual({});
		expect(selectAgentEnvScope(config(), { kind: "project", projectId: null })).toEqual({});
		expect(selectAgentEnvScope(config(), { kind: "task", taskId: "missing" })).toEqual({});
	});
});

describe("applyAgentEnvScope", () => {
	it("writes a scope without touching the others", () => {
		const next = applyAgentEnvScope(config(), { kind: "task", taskId: "t1" }, { C: "30", D: "4" });
		expect(next.tasks.t1).toEqual({ C: "30", D: "4" });
		expect(next.global).toEqual({ A: "1" });
		expect(next.projects).toEqual({ p1: { B: "2" } });
	});

	it("deletes a project/task scope entry when the map is empty", () => {
		expect(applyAgentEnvScope(config(), { kind: "task", taskId: "t1" }, {}).tasks).toEqual({});
		expect(applyAgentEnvScope(config(), { kind: "project", projectId: "p1" }, {}).projects).toEqual({});
	});

	it("clears but keeps the always-present global scope", () => {
		expect(applyAgentEnvScope(config(), { kind: "global" }, {}).global).toEqual({});
	});

	it("is a no-op for a project scope with no id", () => {
		const base = config();
		expect(applyAgentEnvScope(base, { kind: "project", projectId: null }, { X: "1" })).toBe(base);
	});

	it("does not mutate the input config", () => {
		const base = config();
		applyAgentEnvScope(base, { kind: "task", taskId: "t1" }, {});
		expect(base.tasks).toEqual({ t1: { C: "3" } });
	});
});

describe("agentEnvMapsEqual", () => {
	it("is true for equal maps and false otherwise", () => {
		expect(agentEnvMapsEqual({ A: "1", B: "2" }, { B: "2", A: "1" })).toBe(true);
		expect(agentEnvMapsEqual({ A: "1" }, { A: "2" })).toBe(false);
		expect(agentEnvMapsEqual({ A: "1" }, { A: "1", B: "2" })).toBe(false);
		expect(agentEnvMapsEqual({}, {})).toBe(true);
	});
});

describe("agentEnvScopeKey", () => {
	it("produces a stable string identity per scope", () => {
		expect(agentEnvScopeKey({ kind: "global" })).toBe("global");
		expect(agentEnvScopeKey({ kind: "project", projectId: "p1" })).toBe("project:p1");
		expect(agentEnvScopeKey({ kind: "project", projectId: null })).toBe("project:");
		expect(agentEnvScopeKey({ kind: "task", taskId: "t1" })).toBe("task:t1");
	});
});
