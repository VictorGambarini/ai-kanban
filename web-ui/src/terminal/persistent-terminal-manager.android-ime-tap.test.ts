import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

// Regression coverage for the "tapping already-typed terminal output on Android pastes the
// whole line" bug: xterm clears its hidden textarea's value after every keystroke, which can
// leave Android's on-screen keyboard holding a stale IME composing span that gets replayed on
// the next keystroke. The workaround forces a blur/refocus on tap (not drag) to drop it, scoped
// to Android since the blur/refocus also emits a focus-report escape sequence to apps that
// enable it (vim/tmux). jsdom can't emulate real IME composition, so this only verifies the
// gesture-classification and platform-gating logic that decides *whether* to force it, not that
// doing so actually resets a real device's composing span.
class FakeWebSocket {
	static OPEN = 1;
	readyState = 1;
	binaryType = "arraybuffer";
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	constructor(public url: string) {}
	addEventListener() {}
	removeEventListener() {}
	send() {}
	close() {}
}

class FakeResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

const WORKSPACE = "ws-android-ime";
const TASK_ID = "android-ime-task";
const APPEARANCE = { cursorColor: "#fff", terminalBackgroundColor: "#000" };

function setUserAgent(userAgent: string) {
	Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
}

function tap(element: Element, clientY = 100) {
	element.dispatchEvent(
		new TouchEvent("touchstart", { touches: [{ clientY, clientX: 0 } as Touch], bubbles: true, cancelable: true }),
	);
	element.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true, cancelable: true }));
}

function drag(element: Element, fromY: number, toY: number) {
	element.dispatchEvent(
		new TouchEvent("touchstart", {
			touches: [{ clientY: fromY, clientX: 0 } as Touch],
			bubbles: true,
			cancelable: true,
		}),
	);
	element.dispatchEvent(
		new TouchEvent("touchmove", {
			touches: [{ clientY: toY, clientX: 0 } as Touch],
			bubbles: true,
			cancelable: true,
		}),
	);
	element.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true, cancelable: true }));
}

beforeAll(() => {
	(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
	(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
});

describe("Android IME composition reset on tap", () => {
	const originalUserAgent = window.navigator.userAgent;

	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		disposePersistentTerminal(WORKSPACE, TASK_ID);
		window.localStorage.clear();
		setUserAgent(originalUserAgent);
		vi.restoreAllMocks();
	});

	function setUp() {
		setUserAgent(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36",
		);
		const handle = ensurePersistentTerminal({ taskId: TASK_ID, workspaceId: WORKSPACE, ...APPEARANCE });
		const element = document.querySelector(".xterm");
		const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
		if (!element || !textarea) {
			throw new Error("expected xterm to have rendered its element and helper textarea");
		}
		// jsdom never computes layout, so clientHeight is 0; the scroll-distance math in
		// onTouchMove divides by it, which is irrelevant to this test but throws on a real
		// drag gesture if left at 0.
		Object.defineProperty(element, "clientHeight", { value: 400, configurable: true });
		return { handle, element, textarea };
	}

	function spyOnTextarea(textarea: HTMLTextAreaElement) {
		return { blurSpy: vi.spyOn(textarea, "blur"), focusSpy: vi.spyOn(textarea, "focus") };
	}

	it("forces a blur/refocus on a tap that does not move, on Android, while focused", () => {
		const { element, textarea } = setUp();
		textarea.focus();
		const { blurSpy, focusSpy } = spyOnTextarea(textarea);

		tap(element);

		expect(blurSpy).toHaveBeenCalledTimes(1);
		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it("does not force a blur/refocus when the touch drags (scroll gesture)", () => {
		const { element, textarea } = setUp();
		textarea.focus();
		const { blurSpy, focusSpy } = spyOnTextarea(textarea);

		drag(element, 100, 40);

		expect(blurSpy).not.toHaveBeenCalled();
		expect(focusSpy).not.toHaveBeenCalled();
	});

	it("does not force a blur/refocus on non-Android platforms", () => {
		const { element, textarea } = setUp();
		setUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		);
		textarea.focus();
		const { blurSpy, focusSpy } = spyOnTextarea(textarea);

		tap(element);

		expect(blurSpy).not.toHaveBeenCalled();
		expect(focusSpy).not.toHaveBeenCalled();
	});

	it("does not force a blur/refocus when the terminal is not currently focused", () => {
		const { element, textarea } = setUp();
		textarea.blur();
		const { blurSpy, focusSpy } = spyOnTextarea(textarea);

		tap(element);

		expect(blurSpy).not.toHaveBeenCalled();
		expect(focusSpy).not.toHaveBeenCalled();
	});
});
