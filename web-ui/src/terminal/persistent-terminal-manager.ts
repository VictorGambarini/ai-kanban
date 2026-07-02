import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { getTerminalThemeColors, type ThemeTerminalColors } from "@/hooks/use-theme";
import { applyActiveHostToUrl } from "@/runtime/active-host";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import { getMaxLiveTerminalSessions } from "@/terminal/terminal-session-limit";
import { isMacPlatform } from "@/utils/platform";

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const APPROX_TERMINAL_CELL_HEIGHT_PX = 16;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";
// Reconnect backoff: retry quickly at first, capped, so a brief blip self-heals
// without the user noticing. We keep retrying past the silent-attempt budget (at the
// capped delay) so the terminal still recovers once connectivity returns — we just
// stop hiding it and surface a "disconnected" status after that many failures.
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;
const MAX_SILENT_RECONNECT_ATTEMPTS = 6;
// The server pushes a control-socket heartbeat every ~10s. If we see no control
// frame for this long the pipe is assumed half-open (e.g. laptop sleep / network
// change that never delivered a close) and we force a reconnect.
const CONTROL_HEARTBEAT_WATCHDOG_MS = 25_000;

export type TerminalConnectionStatus = "connected" | "reconnecting" | "disconnected";

interface PersistentTerminalAppearance {
	cursorColor: string;
	terminalBackgroundColor: string;
	themeColors?: ThemeTerminalColors;
}

interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onConnectionStatus?: (status: TerminalConnectionStatus) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
}

interface MountPersistentTerminalOptions {
	autoFocus?: boolean;
	isVisible?: boolean;
}

interface EnsurePersistentTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	workspaceId: string;
}

function generateTerminalClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

function getTerminalIoWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/io`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	applyActiveHostToUrl(url);
	return url.toString();
}

function getTerminalControlWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/control`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	applyActiveHostToUrl(url);
	return url.toString();
}

function decodeTerminalSocketChunk(decoder: TextDecoder, data: string | ArrayBuffer | Blob): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return decoder.decode(new Uint8Array(data), { stream: true });
	}
	return "";
}

function getTerminalSocketWriteData(data: string | ArrayBuffer | Blob): string | Uint8Array | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return null;
}

function getTerminalSocketChunkByteLength(data: string | ArrayBuffer | Blob): number {
	if (typeof data === "string") {
		return new TextEncoder().encode(data).byteLength;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return 0;
}

function isCopyShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		((isMacPlatform && event.metaKey && !event.shiftKey && event.key.toLowerCase() === "c") ||
			(!isMacPlatform && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c"))
	);
}

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

class PersistentTerminal {
	private readonly terminal: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly hostElement: HTMLDivElement;
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly parkingRoot: HTMLDivElement;
	private readonly unicode11Addon = new Unicode11Addon();
	// This identifies one browser viewer, not the PTY session itself.
	// The server uses it to keep per-tab restore and socket state while all tabs
	// still share the same taskId backed PTY.
	private readonly clientId = generateTerminalClientId();
	private appearance: PersistentTerminalAppearance;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private connectionReady = false;
	private restoreCompleted = false;
	private connectionStatus: TerminalConnectionStatus = "reconnecting";
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectScheduled = false;
	private intentionallyClosed = false;
	private heartbeatWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	private removeTouchScrollListeners: (() => void) | null = null;
	// The WebGL renderer (GPU context + glyph atlas) is the most expensive part of
	// a terminal and Chrome caps how many WebGL contexts can be live at once. We
	// only attach it while the terminal is mounted/visible and dispose it when the
	// terminal is parked, so parked sessions hold no GPU context.
	private webglAddon: WebglAddon | null = null;
	private disposed = false;

	constructor(
		private readonly taskId: string,
		private readonly workspaceId: string,
		appearance: PersistentTerminalAppearance,
	) {
		this.appearance = appearance;
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
		});
		this.parkingRoot.appendChild(this.hostElement);
		const initialGeometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);

		this.terminal = new Terminal({
			...createKanbanTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: this.appearance.terminalBackgroundColor,
				themeColors: this.appearance.themeColors ?? getTerminalThemeColors(),
			}),
			cols: initialGeometry.cols,
			rows: initialGeometry.rows,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
		this.terminal.open(this.hostElement);
		this.setupTouchScrolling();
		this.terminal.onData((data) => {
			this.sendIoData(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.sendIoData(bytes);
		});
		this.terminal.attachCustomKeyEventHandler((event) => {
			if (event.key === "Enter" && event.shiftKey) {
				if (event.type === "keydown") {
					this.terminal.input(SHIFT_ENTER_SEQUENCE);
				}
				return false;
			}
			if (isCopyShortcut(event) && this.terminal.hasSelection()) {
				void navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {
					// Ignore clipboard failures.
				});
				return false;
			}
			return true;
		});

		this.ensureConnected();
	}

	get isMounted(): boolean {
		return this.visibleContainer !== null;
	}

	private attachWebglRenderer(): void {
		if (this.disposed || this.webglAddon) {
			return;
		}
		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				this.detachWebglRenderer();
			});
			this.terminal.loadAddon(webglAddon);
			this.webglAddon = webglAddon;
		} catch {
			// Fall back to the default renderer when WebGL is unavailable.
			this.webglAddon = null;
		}
	}

	private detachWebglRenderer(): void {
		if (!this.webglAddon) {
			return;
		}
		try {
			this.webglAddon.dispose();
		} catch {
			// Ignore renderer teardown failures; the addon may already be gone.
		}
		this.webglAddon = null;
	}

	// xterm has no touch scrolling of its own, and the two buffers scroll by
	// completely different mechanisms, so a single-finger drag has to be routed to
	// the right one:
	//   - Normal buffer (a shell): scroll xterm's own scrollback via `scrollLines`.
	//   - Alternate buffer (a full-screen TUI like Claude Code): there is no
	//     scrollback, so `scrollLines` is inert. These apps enable mouse tracking
	//     and scroll in response to wheel input, so we replay the drag as a `wheel`
	//     on `.xterm-screen` — xterm forwards it to the app as the exact same mouse
	//     sequence a desktop wheel produces. (Synthetic wheels do not drive xterm's
	//     own scrollback, which is why the normal buffer still uses `scrollLines`.)
	private setupTouchScrolling(): void {
		const element = this.terminal.element;
		if (!element) {
			return;
		}
		let lastTouchY: number | null = null;
		let scrollRemainderPx = 0;

		const onTouchStart = (event: TouchEvent) => {
			const touch = event.touches.length === 1 ? event.touches[0] : null;
			lastTouchY = touch ? touch.clientY : null;
			scrollRemainderPx = 0;
		};

		const onTouchMove = (event: TouchEvent) => {
			const touch = event.touches.length === 1 ? event.touches[0] : null;
			if (lastTouchY === null || !touch) {
				return;
			}
			// Finger moving down yields a negative delta — scrolling up to reveal
			// earlier output (natural content-tracking touch scrolling). This matches
			// the sign of both a wheel's deltaY and `scrollLines`.
			const deltaY = lastTouchY - touch.clientY;
			lastTouchY = touch.clientY;
			if (deltaY === 0) {
				return;
			}

			if (this.terminal.buffer.active.type === "alternate") {
				const screen = element.querySelector(".xterm-screen") ?? element;
				screen.dispatchEvent(
					new WheelEvent("wheel", {
						deltaY,
						deltaMode: WheelEvent.DOM_DELTA_PIXEL,
						clientX: touch.clientX,
						clientY: touch.clientY,
						bubbles: true,
						cancelable: true,
					}),
				);
			} else {
				const cellHeight =
					this.terminal.rows > 0 ? element.clientHeight / this.terminal.rows : APPROX_TERMINAL_CELL_HEIGHT_PX;
				const totalPx = deltaY + scrollRemainderPx;
				const deltaRows = Math.trunc(totalPx / cellHeight);
				if (deltaRows !== 0) {
					this.terminal.scrollLines(deltaRows);
					scrollRemainderPx = totalPx - deltaRows * cellHeight;
				} else {
					scrollRemainderPx = totalPx;
				}
			}
			event.preventDefault();
		};

		const onTouchEnd = () => {
			lastTouchY = null;
			scrollRemainderPx = 0;
		};

		element.addEventListener("touchstart", onTouchStart, { passive: true });
		element.addEventListener("touchmove", onTouchMove, { passive: false });
		element.addEventListener("touchend", onTouchEnd, { passive: true });
		element.addEventListener("touchcancel", onTouchEnd, { passive: true });
		this.removeTouchScrollListeners = () => {
			element.removeEventListener("touchstart", onTouchStart);
			element.removeEventListener("touchmove", onTouchMove);
			element.removeEventListener("touchend", onTouchEnd);
			element.removeEventListener("touchcancel", onTouchEnd);
		};
	}

	private notifyLastError(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onLastError?.(this.lastError);
		}
	}

	private notifySummary(summary: RuntimeTaskSessionSummary): void {
		this.latestSummary = summary;
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(summary);
		}
	}

	private notifyOutputText(text: string): void {
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	private notifyConnectionReady(): void {
		this.connectionReady = true;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(this.taskId);
		}
	}

	private setConnectionStatus(status: TerminalConnectionStatus): void {
		if (this.connectionStatus === status) {
			return;
		}
		this.connectionStatus = status;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionStatus?.(status);
		}
	}

	// Recompute the transport status from the live socket states. Reaching a fully
	// open pair clears the reconnect budget and any stale error; otherwise we stay
	// "reconnecting" (silent) until the budget is spent, then flip to "disconnected".
	private refreshConnectionStatus(): void {
		const bothOpen =
			this.ioSocket?.readyState === WebSocket.OPEN && this.controlSocket?.readyState === WebSocket.OPEN;
		if (bothOpen) {
			this.reconnectAttempts = 0;
			if (this.lastError !== null) {
				this.lastError = null;
				this.notifyLastError();
			}
			this.setConnectionStatus("connected");
			return;
		}
		if (this.reconnectAttempts > MAX_SILENT_RECONNECT_ATTEMPTS) {
			this.setConnectionStatus("disconnected");
			return;
		}
		this.setConnectionStatus("reconnecting");
	}

	private clearHeartbeatWatchdog(): void {
		if (this.heartbeatWatchdogTimer !== null) {
			clearTimeout(this.heartbeatWatchdogTimer);
			this.heartbeatWatchdogTimer = null;
		}
	}

	// Any control frame (state, restore, and especially the periodic heartbeat) means
	// the pipe is alive. Resetting on every frame turns a stalled connection into a
	// detectable event even when no close/error is ever delivered.
	private resetHeartbeatWatchdog(): void {
		this.clearHeartbeatWatchdog();
		if (this.disposed || this.intentionallyClosed) {
			return;
		}
		this.heartbeatWatchdogTimer = setTimeout(() => {
			this.heartbeatWatchdogTimer = null;
			this.handleConnectionLost();
		}, CONTROL_HEARTBEAT_WATCHDOG_MS);
	}

	// Tear down both sockets and schedule a single reconnect of the pair. Both legs
	// share one network path, so recovering them together avoids half-open limbo and
	// the restore-snapshot races of reconnecting them independently.
	private handleConnectionLost(): void {
		if (this.disposed || this.intentionallyClosed || this.reconnectScheduled) {
			return;
		}
		this.reconnectScheduled = true;
		this.connectionReady = false;
		this.restoreCompleted = false;
		this.clearHeartbeatWatchdog();
		this.closeSocketsForReconnect();

		this.reconnectAttempts += 1;
		this.refreshConnectionStatus();
		if (this.reconnectAttempts > MAX_SILENT_RECONNECT_ATTEMPTS && this.lastError === null) {
			this.lastError = "Connection lost. Retrying…";
			this.notifyLastError();
		}

		const exponentialDelay = RECONNECT_BASE_DELAY_MS * 2 ** Math.min(this.reconnectAttempts - 1, 6);
		const cappedDelay = Math.min(exponentialDelay, RECONNECT_MAX_DELAY_MS);
		const delay = cappedDelay + Math.floor(Math.random() * 250);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.reconnectScheduled = false;
			if (this.disposed || this.intentionallyClosed) {
				return;
			}
			this.ensureConnected();
		}, delay);
	}

	// Detach handlers and close the current sockets. Nulling our references first means
	// the old sockets' own close/message handlers no-op (they guard on identity), so
	// this never re-enters handleConnectionLost.
	private closeSocketsForReconnect(): void {
		const io = this.ioSocket;
		const control = this.controlSocket;
		this.ioSocket = null;
		this.controlSocket = null;
		this.outputTextDecoder = new TextDecoder();
		if (io) {
			try {
				io.close();
			} catch {
				// Ignore close failures on an already-dead socket.
			}
		}
		if (control) {
			try {
				control.close();
			} catch {
				// Ignore close failures on an already-dead socket.
			}
		}
	}

	private sendControlMessage(message: RuntimeTerminalWsClientMessage): void {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.controlSocket.send(JSON.stringify(message));
	}

	private sendIoData(data: string | Uint8Array): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	private enqueueTerminalWrite(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.disposed) {
							resolve();
							return;
						}
						this.terminal.write(data, () => {
							if (notifyText) {
								this.notifyOutputText(notifyText);
							}
							if (ackBytes > 0) {
								this.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							resolve();
						});
					}),
			);
		return this.terminalWriteQueue;
	}

	private async applyRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		await this.terminalWriteQueue.catch(() => undefined);
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (!snapshot) {
			return;
		}
		await this.enqueueTerminalWrite(snapshot);
	}

	// Routed through terminalWriteQueue so a fit/resize can never land in the middle of
	// an in-flight terminal.write() (e.g. a large applyRestore() scrollback snapshot).
	// xterm.js processes big writes across multiple frames, and resizing mid-write
	// reflows only the not-yet-processed portion of the buffer to the new column
	// count, leaving part of the scrollback wrapped at the old width.
	private requestResize(): void {
		if (!this.visibleContainer) {
			return;
		}
		this.terminalWriteQueue = this.terminalWriteQueue.catch(() => undefined).then(() => this.performResize());
	}

	private performResize(): void {
		if (this.disposed || !this.visibleContainer) {
			return;
		}
		this.fitAddon.fit();
		const bounds = this.visibleContainer.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		reportTerminalGeometry(this.taskId, {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
		this.sendControlMessage({
			type: "resize",
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
		});
	}

	private connectIo(): void {
		if (this.ioSocket) {
			return;
		}
		const ioSocket = new WebSocket(getTerminalIoWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		ioSocket.binaryType = "arraybuffer";
		ioSocket.addEventListener("message", (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			void this.enqueueTerminalWrite(writeData, {
				ackBytes: getTerminalSocketChunkByteLength(event.data),
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.refreshConnectionStatus();
			if (this.restoreCompleted && this.visibleContainer) {
				this.requestResize();
			}
			if (this.restoreCompleted) {
				this.notifyConnectionReady();
			}
		};
		ioSocket.onerror = () => {
			// onerror is immediately followed by onclose, which drives reconnection.
			// We stay quiet here so a transient blip doesn't flash an error mid-recovery.
		};
		ioSocket.onclose = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.handleConnectionLost();
		};
	}

	private connectControl(): void {
		const controlSocket = new WebSocket(getTerminalControlWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		this.controlSocket = controlSocket;
		controlSocket.onopen = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.refreshConnectionStatus();
			this.resetHeartbeatWatchdog();
		};
		controlSocket.onmessage = (event) => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			// Any control frame proves the pipe is alive; restart the stall watchdog.
			this.resetHeartbeatWatchdog();
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				// Ignore malformed control frames.
				return;
			}

			if (payload.type === "heartbeat") {
				// Liveness only — the watchdog reset above is the whole effect.
				return;
			}

			if (payload.type === "restore") {
				this.restoreCompleted = false;
				void this.applyRestore(payload.snapshot, payload.cols, payload.rows)
					.then(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.restoreCompleted = true;
						this.sendControlMessage({ type: "restore_complete" });
						if (this.ioSocket && this.visibleContainer) {
							this.requestResize();
						}
						if (this.ioSocket) {
							this.notifyConnectionReady();
						}
					})
					.catch(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.lastError = "Terminal restore failed.";
						this.notifyLastError();
					});
				return;
			}
			if (payload.type === "state") {
				this.notifySummary(payload.summary);
				return;
			}
			if (payload.type === "exit") {
				const label = payload.code == null ? "session exited" : `session exited with code ${payload.code}`;
				void this.enqueueTerminalWrite(`\r\n[kanban] ${label}\r\n`);
				return;
			}
			if (payload.type === "error") {
				this.lastError = payload.message;
				this.notifyLastError();
				void this.enqueueTerminalWrite(`\r\n[kanban] ${payload.message}\r\n`);
			}
		};
		controlSocket.onerror = () => {
			// onerror is immediately followed by onclose, which drives reconnection.
		};
		controlSocket.onclose = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.controlSocket = null;
			this.clearHeartbeatWatchdog();
			this.handleConnectionLost();
		};
	}

	private ensureConnected(): void {
		if (this.disposed) {
			return;
		}
		if (!this.ioSocket) {
			this.connectIo();
		}
		if (!this.controlSocket) {
			this.connectControl();
		}
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.terminal.options.theme = {
			...this.terminal.options.theme,
			...createKanbanTerminalOptions({
				cursorColor: appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: appearance.terminalBackgroundColor,
				themeColors: appearance.themeColors ?? getTerminalThemeColors(),
			}).theme,
		};
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		subscriber.onConnectionStatus?.(this.connectionStatus);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	// Force an immediate reconnect attempt, resetting the backoff. Used by the manual
	// "Reconnect" affordance when the transport has been flagged disconnected.
	reconnect(): void {
		if (this.disposed) {
			return;
		}
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnectScheduled = false;
		this.reconnectAttempts = 0;
		this.handleConnectionLost();
	}

	mount(
		container: HTMLDivElement,
		appearance: PersistentTerminalAppearance,
		options: MountPersistentTerminalOptions,
	): void {
		if (this.disposed) {
			return;
		}
		this.ensureConnected();
		this.updateAppearance(appearance);
		if (this.visibleContainer !== container) {
			this.visibleContainer = container;
			container.appendChild(this.hostElement);
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.requestResize();
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
		if (options.isVisible !== false) {
			this.attachWebglRenderer();
			window.requestAnimationFrame(() => {
				this.requestResize();
				if (options.autoFocus) {
					this.terminal.focus();
				}
			});
		} else {
			this.detachWebglRenderer();
		}
	}

	unmount(container: HTMLDivElement | null): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (container && this.visibleContainer !== container) {
			return;
		}
		this.detachWebglRenderer();
		this.visibleContainer = null;
		clearTerminalGeometry(this.taskId);
		this.parkingRoot.appendChild(this.hostElement);
	}

	focus(): void {
		this.terminal.focus();
	}

	input(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	clear(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.clear();
			});
	}

	reset(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.reset();
			});
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.taskId });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.intentionallyClosed = true;
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.clearHeartbeatWatchdog();
		this.removeTouchScrollListeners?.();
		this.removeTouchScrollListeners = null;
		this.unmount(this.visibleContainer);
		this.ioSocket?.close();
		this.controlSocket?.close();
		this.ioSocket = null;
		this.controlSocket = null;
		this.subscribers.clear();
		this.terminal.dispose();
		this.hostElement.remove();
	}
}

// Insertion order in this Map doubles as least-recently-used order: every access
// re-inserts the key at the end, so the oldest entries sit at the front and are
// the first to be evicted once the live-session cap is exceeded.
const terminals = new Map<string, PersistentTerminal>();

// Dispose the least-recently-used parked terminals until the live count is back
// within the configured cap. The just-touched terminal and any currently mounted
// (visible) terminal are never evicted; an evicted session is rebuilt from the
// server snapshot when reopened.
function evictExcessPersistentTerminals(protectedKey: string): void {
	const max = getMaxLiveTerminalSessions();
	for (const [key, terminal] of terminals) {
		if (terminals.size <= max) {
			break;
		}
		if (key === protectedKey || terminal.isMounted) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
}

export function ensurePersistentTerminal(input: EnsurePersistentTerminalInput): PersistentTerminal {
	const key = buildKey(input.workspaceId, input.taskId);
	const existing = terminals.get(key);
	if (existing) {
		// Re-insert to mark this terminal as most-recently-used.
		terminals.delete(key);
		terminals.set(key, existing);
		existing.setAppearance({
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
			themeColors: input.themeColors,
		});
		return existing;
	}
	const terminal = new PersistentTerminal(input.taskId, input.workspaceId, {
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
		themeColors: input.themeColors,
	});
	terminals.set(key, terminal);
	evictExcessPersistentTerminals(key);
	return terminal;
}

export function disposePersistentTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.dispose();
	terminals.delete(key);
}

export function disposeAllPersistentTerminalsForWorkspace(workspaceId: string): void {
	for (const [key, terminal] of terminals.entries()) {
		if (!key.startsWith(`${workspaceId}:`)) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
}
