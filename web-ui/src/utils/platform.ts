export const isMacPlatform =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

// A function (not a cached const like `isMacPlatform`) since it's read at gesture-handling
// time rather than once at module load, which also lets tests flip `navigator.userAgent`
// per-case without re-importing the module.
export function isAndroidPlatform(): boolean {
	return typeof navigator !== "undefined" && /Android/.test(navigator.userAgent);
}

export const modifierKeyLabel = isMacPlatform ? "Cmd" : "Ctrl";
export const optionKeyLabel = isMacPlatform ? "⌥" : "Alt";
export const pasteShortcutLabel = `${modifierKeyLabel}+V`;
