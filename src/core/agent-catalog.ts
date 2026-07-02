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
		models: [
			{ value: "opus", label: "Opus" },
			{ value: "sonnet", label: "Sonnet" },
			{ value: "haiku", label: "Haiku" },
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
		models: [
			{ value: "gpt-5-codex", label: "GPT-5 Codex" },
			{ value: "gpt-5", label: "GPT-5" },
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
		autonomousArgs: ["--auto"],
		installUrl: "https://github.com/sst/opencode",
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
