/**
 * Unit tests for setPasscode — the caller-supplied passcode path used by the
 * `--passcode <value>` CLI flag. A pinned passcode must validate exactly like a
 * generated one and must (re-)enable enforcement after a prior disable.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	disablePasscode,
	generatePasscode,
	isPasscodeEnabled,
	setPasscode,
	validatePasscode,
} from "../../../src/security/passcode-manager";

describe("setPasscode", () => {
	// Reset to a fresh generated passcode so module state never bleeds across tests.
	afterEach(() => {
		generatePasscode();
	});

	it("enables enforcement and validates the pinned value", () => {
		setPasscode("PinnedPass1");
		expect(isPasscodeEnabled()).toBe(true);
		expect(validatePasscode("PinnedPass1")).toBe(true);
	});

	it("rejects any value other than the pinned one", () => {
		setPasscode("PinnedPass1");
		expect(validatePasscode("wrong-value")).toBe(false);
		expect(validatePasscode("")).toBe(false);
	});

	it("re-enables enforcement after a prior --no-passcode disable", () => {
		disablePasscode();
		expect(isPasscodeEnabled()).toBe(false);

		setPasscode("PinnedPass1");
		expect(isPasscodeEnabled()).toBe(true);
		expect(validatePasscode("PinnedPass1")).toBe(true);
	});
});
