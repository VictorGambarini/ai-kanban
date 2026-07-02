import { loadClaudeStatuslineConfig, saveClaudeStatuslineConfig } from "../config/claude-statusline";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateClaudeStatuslineApiDependencies {
	loadConfig?: typeof loadClaudeStatuslineConfig;
	saveConfig?: typeof saveClaudeStatuslineConfig;
}

export function createClaudeStatuslineApi(
	deps: CreateClaudeStatuslineApiDependencies = {},
): RuntimeTrpcContext["claudeStatuslineApi"] {
	const load = deps.loadConfig ?? loadClaudeStatuslineConfig;
	const save = deps.saveConfig ?? saveClaudeStatuslineConfig;
	return {
		load: () => load(),
		save: (input) => save(input),
	};
}
