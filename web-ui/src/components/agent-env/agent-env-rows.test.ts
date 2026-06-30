import { describe, expect, it } from "vitest";

import {
	createEnvRow,
	findDuplicateEnvKeys,
	isInvalidEnvKey,
	mapToRows,
	rowsToMap,
} from "@/components/agent-env/agent-env-rows";

describe("agent-env-rows", () => {
	it("round-trips a map through rows", () => {
		const rows = mapToRows({ GH_TOKEN: "abc", JIRA: "x" });
		expect(rows).toHaveLength(2);
		expect(rowsToMap(rows)).toEqual({ GH_TOKEN: "abc", JIRA: "x" });
	});

	it("drops empty keys and lets later rows win on duplicates", () => {
		const rows = [createEnvRow("", "ignored"), createEnvRow("A", "first"), createEnvRow("A", "second")];
		expect(rowsToMap(rows)).toEqual({ A: "second" });
	});

	it("trims keys but preserves value whitespace", () => {
		expect(rowsToMap([createEnvRow("  A  ", " spaced ")])).toEqual({ A: " spaced " });
	});

	it("flags invalid and duplicate keys for warnings", () => {
		expect(isInvalidEnvKey("GH-TOKEN")).toBe(true);
		expect(isInvalidEnvKey("GH_TOKEN")).toBe(false);
		expect(isInvalidEnvKey("  ")).toBe(false);
		const duplicates = findDuplicateEnvKeys([createEnvRow("A"), createEnvRow("A"), createEnvRow("B")]);
		expect(duplicates.has("A")).toBe(true);
		expect(duplicates.has("B")).toBe(false);
	});
});
