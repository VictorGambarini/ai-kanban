// Owns the Claude Code status line settings state inside the settings dialog:
// loads the current ~/.claude/statusline.py + settings.json wiring for this
// machine, tracks draft edits, and saves them back.
import { useEffect, useState } from "react";
import { loadClaudeStatusline, saveClaudeStatusline } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId } from "@/runtime/types";

interface UseClaudeStatuslineControllerOptions {
	open: boolean;
	workspaceId: string | null;
	selectedAgentId: RuntimeAgentId;
}

interface SaveResult {
	ok: boolean;
	message?: string;
}

export interface UseClaudeStatuslineControllerResult {
	scriptContent: string;
	setScriptContent: (value: string) => void;
	enabled: boolean;
	setEnabled: (value: boolean) => void;
	scriptPath: string;
	settingsPath: string;
	settingsParseError: string | null;
	isLoading: boolean;
	hasUnsavedChanges: boolean;
	save: () => Promise<SaveResult>;
}

export function useClaudeStatuslineController(
	options: UseClaudeStatuslineControllerOptions,
): UseClaudeStatuslineControllerResult {
	const { open, workspaceId, selectedAgentId } = options;
	const [scriptContent, setScriptContent] = useState("");
	const [enabled, setEnabled] = useState(false);
	const [initialScriptContent, setInitialScriptContent] = useState("");
	const [initialEnabled, setInitialEnabled] = useState(false);
	const [scriptPath, setScriptPath] = useState("");
	const [settingsPath, setSettingsPath] = useState("");
	const [settingsParseError, setSettingsParseError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	useEffect(() => {
		if (!open || selectedAgentId !== "claude") {
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		void loadClaudeStatusline(workspaceId)
			.then((config) => {
				if (cancelled) {
					return;
				}
				setScriptContent(config.scriptContent);
				setInitialScriptContent(config.scriptContent);
				setEnabled(config.enabled);
				setInitialEnabled(config.enabled);
				setScriptPath(config.scriptPath);
				setSettingsPath(config.settingsPath);
				setSettingsParseError(config.settingsParseError);
			})
			.catch(() => {
				if (!cancelled) {
					setSettingsParseError("Could not load the Claude Code status line configuration.");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [open, selectedAgentId, workspaceId]);

	const hasUnsavedChanges = scriptContent !== initialScriptContent || enabled !== initialEnabled;

	const save = async (): Promise<SaveResult> => {
		try {
			const savedConfig = await saveClaudeStatusline(workspaceId, { scriptContent, enabled });
			setScriptContent(savedConfig.scriptContent);
			setInitialScriptContent(savedConfig.scriptContent);
			setEnabled(savedConfig.enabled);
			setInitialEnabled(savedConfig.enabled);
			setScriptPath(savedConfig.scriptPath);
			setSettingsPath(savedConfig.settingsPath);
			setSettingsParseError(savedConfig.settingsParseError);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	};

	return {
		scriptContent,
		setScriptContent,
		enabled,
		setEnabled,
		scriptPath,
		settingsPath,
		settingsParseError,
		isLoading,
		hasUnsavedChanges,
		save,
	};
}
