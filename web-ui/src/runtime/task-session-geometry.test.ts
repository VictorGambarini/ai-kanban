import { describe, expect, it } from "vitest";

import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";

describe("estimateTaskSessionGeometry", () => {
	it("uses one-third viewport width and near-full viewport height", () => {
		expect(estimateTaskSessionGeometry(1440, 900)).toEqual({
			cols: 60,
			rows: 53,
		});
	});

	it("uses near-full viewport width on mobile-width viewports", () => {
		expect(estimateTaskSessionGeometry(390, 844)).toEqual({
			cols: 47,
			rows: 50,
		});
	});

	it("enforces minimum terminal dimensions", () => {
		expect(estimateTaskSessionGeometry(100, 100)).toEqual({
			cols: 20,
			rows: 12,
		});
	});
});
