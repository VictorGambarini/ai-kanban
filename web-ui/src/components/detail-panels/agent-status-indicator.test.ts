import { describe, expect, it } from "vitest";
import { describeAgentStatus } from "@/components/detail-panels/agent-status-indicator";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

function summary(patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "t1",
		state: "running",
		agentId: "claude",
		workspacePath: null,
		pid: 1,
		startedAt: 0,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...patch,
	} as RuntimeTaskSessionSummary;
}

describe("describeAgentStatus", () => {
	it("reports running", () => {
		expect(describeAgentStatus(summary({ state: "running" }))).toMatchObject({ label: "Running", tone: "success" });
	});

	it("distinguishes a crash from a normal review-ready state", () => {
		// Both are state=awaiting_review on the wire; only reviewReason tells them apart.
		const crashed = describeAgentStatus(summary({ state: "awaiting_review", reviewReason: "error" }));
		const review = describeAgentStatus(summary({ state: "awaiting_review", reviewReason: "hook" }));
		expect(crashed).toMatchObject({ label: "Crashed", tone: "danger" });
		expect(crashed.detail).toBeTruthy();
		expect(review).toMatchObject({ label: "Ready for review", tone: "warning" });
	});

	it("treats a clean exit as finished, not review", () => {
		expect(describeAgentStatus(summary({ state: "awaiting_review", reviewReason: "exit" }))).toMatchObject({
			label: "Finished",
			tone: "neutral",
		});
	});

	it("surfaces a crash-loop warning as a crash with the warning as detail", () => {
		const result = describeAgentStatus(
			summary({
				state: "awaiting_review",
				reviewReason: null,
				warningMessage: "Agent stopped after restarting too many times.",
			}),
		);
		expect(result).toMatchObject({ label: "Crashed", tone: "danger" });
		expect(result.detail).toContain("too many times");
	});

	it("handles no session", () => {
		expect(describeAgentStatus(null)).toMatchObject({ label: "No session", tone: "neutral" });
	});
});
