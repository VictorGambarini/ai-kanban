import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getTerminalThemeColors, useTheme } from "@/hooks/use-theme";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	disposePersistentTerminal,
	ensurePersistentTerminal,
	type TerminalConnectionStatus,
} from "@/terminal/persistent-terminal-manager";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";

interface UsePersistentTerminalSessionInput {
	taskId: string;
	workspaceId: string | null;
	enabled?: boolean;
	readOnly?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
	autoFocus?: boolean;
	isVisible?: boolean;
	sessionStartedAt?: number | null;
	terminalBackgroundColor: string;
	cursorColor: string;
}

export interface UsePersistentTerminalSessionResult {
	containerRef: MutableRefObject<HTMLDivElement | null>;
	lastError: string | null;
	isStopping: boolean;
	connectionStatus: TerminalConnectionStatus;
	restoreHadContent: boolean | null;
	clearTerminal: () => void;
	stopTerminal: () => Promise<void>;
	reconnectTerminal: () => void;
}

export function usePersistentTerminalSession({
	taskId,
	workspaceId,
	enabled = true,
	readOnly = false,
	onSummary,
	onConnectionReady,
	autoFocus = false,
	isVisible = true,
	sessionStartedAt = null,
	terminalBackgroundColor,
	cursorColor,
}: UsePersistentTerminalSessionInput): UsePersistentTerminalSessionResult {
	const { themeId } = useTheme();
	const themeColors = useMemo(() => getTerminalThemeColors(themeId), [themeId]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<ReturnType<typeof ensurePersistentTerminal> | null>(null);
	const callbackRef = useRef<{
		onSummary?: (summary: RuntimeTaskSessionSummary) => void;
		onConnectionReady?: (taskId: string) => void;
	}>({
		onSummary,
		onConnectionReady,
	});
	const previousSessionRef = useRef<{
		workspaceId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
	const [isStopping, setIsStopping] = useState(false);
	const [connectionStatus, setConnectionStatus] = useState<TerminalConnectionStatus>("reconnecting");
	const [restoreHadContent, setRestoreHadContent] = useState<boolean | null>(null);
	callbackRef.current = {
		onSummary,
		onConnectionReady,
	};

	useEffect(() => {
		if (!enabled) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			previousSessionRef.current = null;
			setLastError(null);
			setIsStopping(false);
			setRestoreHadContent(null);
			return;
		}

		if (!workspaceId) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			previousSessionRef.current = null;
			setLastError("No project selected.");
			setRestoreHadContent(null);
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const previousSession = previousSessionRef.current;
		const didSessionRestart =
			previousSession !== null &&
			previousSession.workspaceId === workspaceId &&
			previousSession.taskId === taskId &&
			previousSession.sessionStartedAt !== sessionStartedAt;

		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor,
			terminalBackgroundColor,
			themeColors,
		});
		if (didSessionRestart) {
			terminal.reset();
		}
		previousSessionRef.current = {
			workspaceId,
			taskId,
			sessionStartedAt,
		};
		terminalRef.current = terminal;
		const unsubscribe = terminal.subscribe({
			onConnectionReady: (connectedTaskId) => {
				callbackRef.current.onConnectionReady?.(connectedTaskId);
			},
			onConnectionStatus: setConnectionStatus,
			onLastError: setLastError,
			onSummary: (summary) => {
				callbackRef.current.onSummary?.(summary);
			},
			onRestoreResult: setRestoreHadContent,
		});
		terminal.mount(
			container,
			{
				cursorColor,
				terminalBackgroundColor,
				themeColors,
			},
			{
				autoFocus,
				isVisible,
			},
		);
		setLastError(null);
		setIsStopping(false);
		return () => {
			unsubscribe();
			terminal.unmount(container);
			if (terminalRef.current === terminal) {
				terminalRef.current = null;
			}
		};
	}, [
		autoFocus,
		cursorColor,
		enabled,
		isVisible,
		sessionStartedAt,
		taskId,
		terminalBackgroundColor,
		themeColors,
		workspaceId,
	]);

	// Flips the live instance's read-only flag in place, independent of the mount
	// effect above, so a trash->review transition doesn't force an unmount/remount.
	useEffect(() => {
		terminalRef.current?.setReadOnly(readOnly);
	}, [readOnly]);

	useEffect(() => {
		return registerTerminalController(taskId, {
			input: (text) => terminalRef.current?.input(text) ?? false,
			paste: (text) => terminalRef.current?.paste(text) ?? false,
			waitForLikelyPrompt: async (timeoutMs) => await (terminalRef.current?.waitForLikelyPrompt(timeoutMs) ?? false),
		});
	}, [taskId]);

	const stopTerminal = useCallback(async () => {
		if (readOnly) {
			return;
		}
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		setIsStopping(true);
		try {
			await terminal.stop();
		} catch {
			// Keep terminal usable even if stop API fails.
		} finally {
			setIsStopping(false);
		}
	}, [readOnly]);

	const clearTerminal = useCallback(() => {
		if (readOnly) {
			return;
		}
		terminalRef.current?.clear();
	}, [readOnly]);

	const reconnectTerminal = useCallback(() => {
		terminalRef.current?.reconnect();
	}, []);

	return {
		containerRef,
		lastError,
		isStopping,
		connectionStatus,
		restoreHadContent,
		clearTerminal,
		stopTerminal,
		reconnectTerminal,
	};
}
