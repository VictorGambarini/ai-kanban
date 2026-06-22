/**
 * Pure helpers for resolving the CLI passcode flags into an explicit intent.
 *
 * These live outside cli.ts (which self-executes on import) so they can be
 * unit-tested directly. Two flags share Commander's `passcode` destination:
 *
 *   --passcode <value>   pin the remote passcode to a fixed value (string)
 *   --no-passcode        disable passcode enforcement (stored as `false`)
 *
 * When neither flag is supplied Commander yields `true`/`undefined`, which we
 * treat as "auto-generate a random passcode".
 */

export type PasscodeOption = { mode: "auto" } | { mode: "disabled" } | { mode: "fixed"; value: string };

/** Validate and normalize the argument to `--passcode <value>`. */
export function parseCliPasscodeValue(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		throw new Error("Missing value for --passcode. Provide a non-empty passcode.");
	}
	return trimmed;
}

/**
 * Resolve Commander's shared `passcode` destination into an explicit intent.
 * Commander stores `--passcode <value>` as a string, `--no-passcode` as
 * `false`, and `true`/undefined when neither flag is supplied.
 */
export function resolvePasscodeOption(value: string | boolean | undefined): PasscodeOption {
	if (value === false) {
		return { mode: "disabled" };
	}
	if (typeof value === "string") {
		return { mode: "fixed", value };
	}
	return { mode: "auto" };
}
