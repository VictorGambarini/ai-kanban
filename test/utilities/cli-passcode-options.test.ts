import { describe, expect, it } from "vitest";

import { parseCliPasscodeValue, resolvePasscodeOption } from "../../src/cli-passcode-options";

describe("resolvePasscodeOption", () => {
	// Regression: Commander stores `--no-passcode` under the `passcode`
	// destination as `false`, NOT as `noPasscode`. The original code read
	// `options.noPasscode` (always undefined) so --no-passcode never disabled
	// the passcode. These cases lock the corrected mapping in place.
	it("treats `false` (--no-passcode) as disabled", () => {
		expect(resolvePasscodeOption(false)).toEqual({ mode: "disabled" });
	});

	it("treats a string (--passcode <value>) as a pinned passcode", () => {
		expect(resolvePasscodeOption("hunter2pass")).toEqual({ mode: "fixed", value: "hunter2pass" });
	});

	it("treats `true` (Commander's negatable default) as auto-generate", () => {
		expect(resolvePasscodeOption(true)).toEqual({ mode: "auto" });
	});

	it("treats `undefined` (no flag supplied) as auto-generate", () => {
		expect(resolvePasscodeOption(undefined)).toEqual({ mode: "auto" });
	});
});

describe("parseCliPasscodeValue", () => {
	it("returns the trimmed value", () => {
		expect(parseCliPasscodeValue("  my-passcode  ")).toBe("my-passcode");
	});

	it("rejects an empty value", () => {
		expect(() => parseCliPasscodeValue("")).toThrow(/Missing value for --passcode/);
	});

	it("rejects a whitespace-only value", () => {
		expect(() => parseCliPasscodeValue("   ")).toThrow(/Missing value for --passcode/);
	});
});
