import type { ClaudePermissionStrategy } from "@runtime-claude-permission-strategy";
import { ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useClaudePermissionStrategy } from "@/hooks/use-claude-permission-strategy";
import { useClaudePermissionStrategyScopeValue } from "@/hooks/use-claude-permission-strategy-scope";

import {
	applyClaudePermissionStrategyScope,
	selectClaudePermissionStrategyScope,
} from "./claude-permission-strategy-scope";

interface ClaudePermissionStrategySettingsSectionProps {
	open: boolean;
	workspaceId: string | null;
}

const USE_GLOBAL_DEFAULT_VALUE = "__use_global_default__";

/**
 * Settings panel for the Claude Code permission strategy: hard bypass
 * (`--dangerously-skip-permissions`) vs. Claude Code's safer "auto" mode
 * (`--permission-mode auto`, with a classifier screening tool calls for
 * obviously destructive actions). Edits the GLOBAL scope and the active
 * project's scope; per-task overrides are edited on the card. Only relevant
 * while Claude Code is the selected agent in this dialog.
 */
export function ClaudePermissionStrategySettingsSection({
	open,
	workspaceId,
}: ClaudePermissionStrategySettingsSectionProps): JSX.Element {
	const { config, isLoading, isError, isSaving, save } = useClaudePermissionStrategy(open);

	const globalStoredValue = useMemo(() => selectClaudePermissionStrategyScope(config, { kind: "global" }), [config]);
	const projectStoredValue = useMemo(
		() => selectClaudePermissionStrategyScope(config, { kind: "project", projectId: workspaceId }),
		[config, workspaceId],
	);

	const globalScope = useClaudePermissionStrategyScopeValue(globalStoredValue);
	const projectScope = useClaudePermissionStrategyScopeValue(projectStoredValue);
	const [saveError, setSaveError] = useState<string | null>(null);

	const isDirty = globalScope.isDirty || (workspaceId !== null && projectScope.isDirty);

	const handleSave = async (): Promise<void> => {
		setSaveError(null);
		const withGlobal = applyClaudePermissionStrategyScope(config, { kind: "global" }, globalScope.value);
		const nextConfig = workspaceId
			? applyClaudePermissionStrategyScope(
					withGlobal,
					{ kind: "project", projectId: workspaceId },
					projectScope.value,
				)
			: withGlobal;
		try {
			await save(nextConfig);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Could not save the permission strategy.");
		}
	};

	const controlsDisabled = isSaving || isLoading;

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				<ShieldCheck size={14} />
				Permission mode
			</h6>
			<p className="text-text-secondary text-[13px] mt-0 mb-3">
				Controls how autonomous Claude Code tasks handle permissions. <strong>Bypass</strong> skips every permission
				check entirely. <strong>Auto</strong> uses Claude Code's built-in auto mode, which screens tool calls for
				obviously destructive actions before letting them run.
			</p>

			{isLoading ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px] mb-3">
					<Spinner size={14} /> Loading…
				</div>
			) : null}
			{isError && !isLoading ? (
				<div className="rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px] text-text-primary mb-3">
					Could not load the permission strategy.
				</div>
			) : null}

			<div className="flex items-center justify-between gap-2 mb-2">
				<span className="text-text-secondary text-[13px]">Default (global)</span>
				<NativeSelect
					value={globalScope.value ?? "bypass"}
					onChange={(event) => globalScope.setValue(event.target.value as ClaudePermissionStrategy)}
					disabled={controlsDisabled}
					style={{ minWidth: 220 }}
				>
					<option value="bypass">Bypass permissions</option>
					<option value="auto">Auto mode</option>
				</NativeSelect>
			</div>

			{workspaceId ? (
				<div className="flex items-center justify-between gap-2">
					<span className="text-text-secondary text-[13px]">This project</span>
					<NativeSelect
						value={projectScope.value ?? USE_GLOBAL_DEFAULT_VALUE}
						onChange={(event) =>
							projectScope.setValue(
								event.target.value === USE_GLOBAL_DEFAULT_VALUE
									? null
									: (event.target.value as ClaudePermissionStrategy),
							)
						}
						disabled={controlsDisabled}
						style={{ minWidth: 220 }}
					>
						<option value={USE_GLOBAL_DEFAULT_VALUE}>Use global default</option>
						<option value="bypass">Bypass permissions</option>
						<option value="auto">Auto mode</option>
					</NativeSelect>
				</div>
			) : null}

			{saveError ? (
				<div className="flex gap-2 rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px] mt-3">
					<span className="text-text-primary">{saveError}</span>
				</div>
			) : null}

			<div className="flex justify-end mt-3">
				<Button variant="primary" size="sm" onClick={handleSave} disabled={controlsDisabled || !isDirty}>
					{isSaving ? "Saving…" : "Save permission mode"}
				</Button>
			</div>
		</div>
	);
}
