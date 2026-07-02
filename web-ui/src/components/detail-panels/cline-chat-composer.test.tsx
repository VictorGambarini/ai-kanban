import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClineChatComposer } from "@/components/detail-panels/cline-chat-composer";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskImage } from "@/types";

function renderComposer(root: Root, element: ReactElement): void {
	root.render(<TooltipProvider>{element}</TooltipProvider>);
}

function getSendButton(container: HTMLElement): HTMLButtonElement {
	const sendButton = container.querySelector('button[aria-label="Send message"]');
	expect(sendButton).toBeInstanceOf(HTMLButtonElement);
	if (!(sendButton instanceof HTMLButtonElement)) {
		throw new Error("Expected composer send button");
	}
	return sendButton;
}

const draftImage: TaskImage = {
	id: "img-1",
	data: "abc123",
	mimeType: "image/png",
};

function baseProps(overrides: Partial<Parameters<typeof ClineChatComposer>[0]> = {}) {
	return {
		taskId: "task-1",
		draft: "Take a look at this",
		onDraftChange: vi.fn(),
		images: [draftImage],
		onImagesChange: vi.fn(),
		placeholder: "Message Cline",
		mode: "act" as const,
		onModeChange: vi.fn(),
		showModeToggle: false,
		canSend: true,
		canCancel: false,
		onSend: vi.fn(),
		onCancel: vi.fn(),
		modelOptions: [],
		selectedModelId: "claude-sonnet",
		selectedModelButtonText: "Claude Sonnet",
		onSelectModel: vi.fn(),
		selectedReasoningEffort: "" as const,
		onSelectReasoningEffort: vi.fn(),
		...overrides,
	};
}

describe("ClineChatComposer", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("blocks sending when an attachment warning is present for a non-vision model", async () => {
		const onSend = vi.fn();
		await act(async () => {
			renderComposer(
				root,
				<ClineChatComposer
					{...baseProps({
						onSend,
						attachmentWarningMessage:
							"The selected Cline model may not accept image input. Choose a vision-capable model to use these images.",
					})}
				/>,
			);
			await Promise.resolve();
		});

		const sendButton = getSendButton(container);
		expect(sendButton.disabled).toBe(true);
		expect(container.textContent).toContain("may not accept image input");

		sendButton.click();
		expect(onSend).not.toHaveBeenCalled();
	});

	it("allows sending images when no attachment warning is present", async () => {
		const onSend = vi.fn();
		await act(async () => {
			renderComposer(root, <ClineChatComposer {...baseProps({ onSend, attachmentWarningMessage: null })} />);
			await Promise.resolve();
		});

		const sendButton = getSendButton(container);
		expect(sendButton.disabled).toBe(false);

		await act(async () => {
			sendButton.click();
			await Promise.resolve();
		});
		expect(onSend).toHaveBeenCalledTimes(1);
	});
});
