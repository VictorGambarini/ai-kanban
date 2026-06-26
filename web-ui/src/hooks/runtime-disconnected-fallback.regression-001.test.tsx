// Regression: ISSUE-001 — selecting an unreachable remote host dropped the user
// into a dead-end disconnect screen with no way back to the local hub.
// Found by /qa on 2026-06-27
// Report: .gstack/qa-reports/qa-report-localhost-2026-06-27.md
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";

const LOCAL = "local";
const hoisted = vi.hoisted(() => ({
	activeHostId: "local",
	setActiveHostId: vi.fn(),
}));
const setActiveHostIdMock = hoisted.setActiveHostId;

vi.mock("@/runtime/active-host", () => ({
	LOCAL_HOST_ID: "local",
	getActiveHostId: () => hoisted.activeHostId,
	isLocalActiveHost: () => hoisted.activeHostId === "local",
	setActiveHostId: (...args: unknown[]) => hoisted.setActiveHostId(...args),
}));

describe("RuntimeDisconnectedFallback", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		hoisted.activeHostId = LOCAL;
		setActiveHostIdMock.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("shows local terminal guidance with no recovery button when the host is local", () => {
		act(() => {
			root.render(<RuntimeDisconnectedFallback />);
		});

		expect(container.textContent).toContain("Disconnected from Cline");
		expect(container.textContent).toContain("Run cline again in your terminal");
		expect(container.querySelector("button")).toBeNull();
	});

	it("offers a local-hub escape hatch naming the unreachable remote host", () => {
		hoisted.activeHostId = "qa-test-van";

		act(() => {
			root.render(<RuntimeDisconnectedFallback />);
		});

		expect(container.textContent).toContain("Can't reach remote host");
		expect(container.textContent).toContain("qa-test-van");

		const switchButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Switch to local hub"),
		);
		expect(switchButton).toBeDefined();
	});

	it("switches back to the local hub when the escape hatch is clicked", () => {
		hoisted.activeHostId = "qa-test-van";

		act(() => {
			root.render(<RuntimeDisconnectedFallback />);
		});

		const switchButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Switch to local hub"),
		);

		act(() => {
			switchButton?.click();
		});

		expect(setActiveHostIdMock).toHaveBeenCalledWith(LOCAL);
	});
});
