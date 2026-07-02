// Manages the Claude Code CLI's `statusLine` script and settings.json wiring on
// this machine. Unlike src/config/runtime-config.ts, the settings.json touched
// here is NOT Kanban-owned — it is the user's real ~/.claude/settings.json,
// which they may also hand-edit, so writes must preserve every unrelated key.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeClaudeStatuslineConfig, RuntimeClaudeStatuslineSaveRequest } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";

function asPlainObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

export function getClaudeStatuslineScriptPath(): string {
	return join(homedir(), ".claude", "statusline.py");
}

export function getClaudeSettingsPath(): string {
	return join(homedir(), ".claude", "settings.json");
}

async function readTextFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

interface ClaudeSettingsFileState {
	settings: Record<string, unknown> | null;
	parseError: string | null;
}

async function readClaudeSettingsFile(settingsPath: string): Promise<ClaudeSettingsFileState> {
	const raw = await readTextFileIfExists(settingsPath);
	if (raw === null) {
		return { settings: {}, parseError: null };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		const settings = asPlainObject(parsed);
		if (!settings) {
			return { settings: null, parseError: `${settingsPath} does not contain a JSON object.` };
		}
		return { settings, parseError: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { settings: null, parseError: `Could not parse ${settingsPath}: ${message}` };
	}
}

function expandHomeDirTilde(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

function isStatusLineActiveForScript(settings: Record<string, unknown> | null, scriptPath: string): boolean {
	const statusLine = asPlainObject(settings?.statusLine);
	if (statusLine?.type !== "command" || typeof statusLine.command !== "string") {
		return false;
	}
	return expandHomeDirTilde(statusLine.command) === scriptPath;
}

export async function loadClaudeStatuslineConfig(): Promise<RuntimeClaudeStatuslineConfig> {
	const scriptPath = getClaudeStatuslineScriptPath();
	const settingsPath = getClaudeSettingsPath();
	const scriptContent = (await readTextFileIfExists(scriptPath)) ?? "";
	const { settings, parseError } = await readClaudeSettingsFile(settingsPath);
	return {
		scriptPath,
		settingsPath,
		scriptContent,
		enabled: isStatusLineActiveForScript(settings, scriptPath),
		settingsParseError: parseError,
	};
}

export async function saveClaudeStatuslineConfig(
	input: RuntimeClaudeStatuslineSaveRequest,
): Promise<RuntimeClaudeStatuslineConfig> {
	const scriptPath = getClaudeStatuslineScriptPath();
	const settingsPath = getClaudeSettingsPath();
	const trimmedScriptContent = input.scriptContent.trim();

	if (input.enabled && trimmedScriptContent.length === 0) {
		throw new Error("Add a script before enabling the status line.");
	}

	if (trimmedScriptContent.length > 0) {
		await lockedFileSystem.writeTextFileAtomic(scriptPath, input.scriptContent, { executable: true });
	}

	await lockedFileSystem.withLock({ path: settingsPath, type: "file" }, async () => {
		const { settings, parseError } = await readClaudeSettingsFile(settingsPath);
		if (parseError || !settings) {
			throw new Error(parseError ?? `Could not read ${settingsPath}.`);
		}

		const next = { ...settings };
		if (input.enabled) {
			const existingStatusLine = asPlainObject(next.statusLine) ?? {};
			next.statusLine = { ...existingStatusLine, type: "command", command: scriptPath };
		} else if (isStatusLineActiveForScript(next, scriptPath)) {
			delete next.statusLine;
		}

		await lockedFileSystem.writeJsonFileAtomic(settingsPath, next, { lock: null });
	});

	return await loadClaudeStatuslineConfig();
}
