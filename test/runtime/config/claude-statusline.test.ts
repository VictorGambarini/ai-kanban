import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadClaudeStatuslineConfig, saveClaudeStatuslineConfig } from "../../../src/config/claude-statusline";
import { createTempDir } from "../../utilities/temp-dir";

function withTemporaryHome<T>(home: string, run: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	});
}

describe.sequential("claude-statusline", () => {
	it("returns defaults when no files exist yet", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				const config = await loadClaudeStatuslineConfig();
				expect(config.scriptContent).toBe("");
				expect(config.enabled).toBe(false);
				expect(config.settingsParseError).toBeNull();
				expect(config.scriptPath).toBe(join(temp.path, ".claude", "statusline.py"));
				expect(config.settingsPath).toBe(join(temp.path, ".claude", "settings.json"));
			});
		} finally {
			temp.cleanup();
		}
	});

	it("writes an executable script and merges statusLine into a fresh settings.json", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				const script = "#!/usr/bin/env python3\nprint('hi')\n";
				const saved = await saveClaudeStatuslineConfig({ scriptContent: script, enabled: true });

				expect(saved.enabled).toBe(true);
				expect(saved.scriptContent).toBe(script);
				expect(readFileSync(saved.scriptPath, "utf8")).toBe(script);
				if (process.platform !== "win32") {
					expect(statSync(saved.scriptPath).mode & 0o777).toBe(0o755);
				}

				const settings = JSON.parse(readFileSync(saved.settingsPath, "utf8")) as Record<string, unknown>;
				expect(settings.statusLine).toEqual({ type: "command", command: saved.scriptPath });
			});
		} finally {
			temp.cleanup();
		}
	});

	it("preserves pre-existing unrelated keys in settings.json", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				const { mkdirSync, writeFileSync } = await import("node:fs");
				const claudeDir = join(temp.path, ".claude");
				mkdirSync(claudeDir, { recursive: true });
				writeFileSync(
					join(claudeDir, "settings.json"),
					JSON.stringify({ theme: "dark", model: "opus" }, null, 2),
					"utf8",
				);

				const saved = await saveClaudeStatuslineConfig({
					scriptContent: "#!/usr/bin/env python3\n",
					enabled: true,
				});
				const settings = JSON.parse(readFileSync(saved.settingsPath, "utf8")) as Record<string, unknown>;
				expect(settings.theme).toBe("dark");
				expect(settings.model).toBe("opus");
				expect(settings.statusLine).toEqual({ type: "command", command: saved.scriptPath });
			});
		} finally {
			temp.cleanup();
		}
	});

	it("removes statusLine on disable only when it points at Kanban's script", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				await saveClaudeStatuslineConfig({ scriptContent: "#!/usr/bin/env python3\n", enabled: true });
				const disabled = await saveClaudeStatuslineConfig({
					scriptContent: "#!/usr/bin/env python3\n",
					enabled: false,
				});
				expect(disabled.enabled).toBe(false);
				const settings = JSON.parse(readFileSync(disabled.settingsPath, "utf8")) as Record<string, unknown>;
				expect(settings.statusLine).toBeUndefined();
			});
		} finally {
			temp.cleanup();
		}
	});

	it("leaves an unrelated manually-configured statusLine untouched when disabling", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				const { mkdirSync, writeFileSync } = await import("node:fs");
				const claudeDir = join(temp.path, ".claude");
				mkdirSync(claudeDir, { recursive: true });
				writeFileSync(
					join(claudeDir, "settings.json"),
					JSON.stringify({ statusLine: { type: "command", command: "/some/other/script.sh" } }, null, 2),
					"utf8",
				);

				const disabled = await saveClaudeStatuslineConfig({ scriptContent: "", enabled: false });
				const settings = JSON.parse(readFileSync(disabled.settingsPath, "utf8")) as Record<string, unknown>;
				expect(settings.statusLine).toEqual({ type: "command", command: "/some/other/script.sh" });
				expect(existsSync(disabled.scriptPath)).toBe(false);
			});
		} finally {
			temp.cleanup();
		}
	});

	// Regression: /qa found this on 2026-07-02 — Anthropic's own Claude Code docs
	// example uses a tilde path ("~/.claude/statusline.sh") for statusLine.command,
	// so a manually-configured tilde path pointing at Kanban's script must still
	// read back as enabled, and disabling it must still remove it.
	it("recognizes a tilde-prefixed statusLine.command as active for Kanban's script", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				const { mkdirSync, writeFileSync } = await import("node:fs");
				const claudeDir = join(temp.path, ".claude");
				mkdirSync(claudeDir, { recursive: true });
				writeFileSync(join(claudeDir, "statusline.py"), "#!/usr/bin/env python3\n", { mode: 0o755 });
				writeFileSync(
					join(claudeDir, "settings.json"),
					JSON.stringify({ statusLine: { type: "command", command: "~/.claude/statusline.py" } }, null, 2),
					"utf8",
				);

				const loaded = await loadClaudeStatuslineConfig();
				expect(loaded.enabled).toBe(true);

				const disabled = await saveClaudeStatuslineConfig({
					scriptContent: "#!/usr/bin/env python3\n",
					enabled: false,
				});
				expect(disabled.enabled).toBe(false);
				const settings = JSON.parse(readFileSync(disabled.settingsPath, "utf8")) as Record<string, unknown>;
				expect(settings.statusLine).toBeUndefined();
			});
		} finally {
			temp.cleanup();
		}
	});

	it("throws when enabling with empty script content", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				await expect(saveClaudeStatuslineConfig({ scriptContent: "   ", enabled: true })).rejects.toThrow(
					"Add a script before enabling the status line.",
				);
			});
		} finally {
			temp.cleanup();
		}
	});

	it("surfaces a parse error on load and blocks save for a corrupt settings.json", async () => {
		const temp = createTempDir();
		try {
			await withTemporaryHome(temp.path, async () => {
				const { mkdirSync, writeFileSync } = await import("node:fs");
				const claudeDir = join(temp.path, ".claude");
				mkdirSync(claudeDir, { recursive: true });
				writeFileSync(join(claudeDir, "settings.json"), "{ not valid json", "utf8");

				const loaded = await loadClaudeStatuslineConfig();
				expect(loaded.settingsParseError).toContain("Could not parse");

				await expect(
					saveClaudeStatuslineConfig({ scriptContent: "#!/usr/bin/env python3\n", enabled: true }),
				).rejects.toThrow("Could not parse");
			});
		} finally {
			temp.cleanup();
		}
	});
});
