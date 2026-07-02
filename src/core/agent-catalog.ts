import type { RuntimeAgentId } from "./api-contract";

export interface RuntimeAgentModelOption {
	value: string;
	label: string;
}

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
	/**
	 * CLI flag used to pin the model for a single run (for example "--model").
	 * Only set for agents whose CLI accepts a model override. When absent, the
	 * per-task model picker is hidden for that agent.
	 */
	modelFlag?: string;
	/**
	 * Curated list of common models for the picker dropdown. The picker also
	 * offers a free-text "Custom" entry, so this list need not be exhaustive.
	 */
	models?: RuntimeAgentModelOption[];
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--dangerously-skip-permissions"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		modelFlag: "--model",
		// Mirrors Claude Code's own `/model` picker (aliases accepted by `--model`).
		models: [
			{ value: "sonnet", label: "Sonnet 5" },
			{ value: "fable", label: "Fable 5" },
			{ value: "opus", label: "Opus 4.8" },
			{ value: "haiku", label: "Haiku 4.5" },
		],
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		modelFlag: "--model",
		// Mirrors Codex's own "Select Model and Effort" picker (verified these are the exact
		// values accepted by `--model`/`-m`).
		models: [
			{ value: "gpt-5.5", label: "GPT-5.5" },
			{ value: "gpt-5.4", label: "GPT-5.4" },
			{ value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
			{ value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
			{ value: "gpt-5.2", label: "GPT-5.2" },
		],
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		// OpenCode's CLI has no autonomous/permission-bypass flag; autonomous mode is
		// applied via a generated `permission: "allow"` config entry instead (see
		// opencodeAdapter in agent-session-adapters.ts).
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
		modelFlag: "--model",
		// The OpenCode Zen models below are bundled and free on every OpenCode install
		// (verified via `opencode models opencode`), so they work with zero setup. Models
		// from other providers (Anthropic, OpenAI, Google, custom gateways, ...) require
		// that provider to be configured first — use "Custom…" for those.
		models: [
			{ value: "opencode/big-pickle", label: "Big Pickle (Free)" },
			{ value: "opencode/north-mini-code-free", label: "North Mini Code (Free)" },
			{ value: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra (Free)" },
			{ value: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash (Free)" },
			{ value: "opencode/mimo-v2.5-free", label: "MiMo V2.5 (Free)" },
		],
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
		modelFlag: "--model",
		models: [
			{ value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
			{ value: "gpt-5-codex", label: "GPT-5 Codex" },
		],
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
		modelFlag: "--model",
		models: [
			{ value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
			{ value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
		],
	},
];

export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = [
	"cline",
	"claude",
	"codex",
	"opencode",
	"droid",
	"kiro",
	// Gemini remains gated pending a separate review.
	// "gemini",
];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}
