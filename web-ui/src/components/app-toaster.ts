import { toast } from "sonner";

interface AppToastAction {
	label: string;
	onClick: () => void;
}

interface AppToastProps {
	intent?: "danger" | "warning" | "success" | "primary" | "none";
	icon?: string;
	message: string;
	timeout?: number;
	action?: AppToastAction;
}

interface NotifyErrorOptions {
	key?: string;
	timeout?: number;
	action?: AppToastAction;
}

export function showAppToast(props: AppToastProps, key?: string): void {
	const options: Parameters<typeof toast>[1] = {
		id: key,
		duration: props.timeout ?? 5000,
		action: props.action,
	};

	if (props.intent === "danger") {
		toast.error(props.message, options);
	} else if (props.intent === "warning") {
		toast.warning(props.message, options);
	} else if (props.intent === "success") {
		toast.success(props.message, options);
	} else {
		toast(props.message, options);
	}
}

export function dismissAppToast(key: string): void {
	toast.dismiss(key);
}

export function notifyError(message: string | null | undefined, options?: NotifyErrorOptions): void {
	const normalized = message?.trim();
	if (!normalized) {
		return;
	}
	showAppToast(
		{
			intent: "danger",
			icon: "warning-sign",
			message: normalized,
			timeout: options?.timeout ?? 7000,
			action: options?.action,
		},
		options?.key ?? `error:${normalized}`,
	);
}
