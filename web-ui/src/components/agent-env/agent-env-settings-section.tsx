import type { AgentEnvConfig } from "@runtime-agent-env";
import { KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAgentEnv } from "@/hooks/use-agent-env";

import { type EnvRow, mapToRows, rowsToMap } from "./agent-env-rows";
import { EnvVarsEditor } from "./env-vars-editor";

interface AgentEnvSettingsSectionProps {
	open: boolean;
	workspaceId: string | null;
}

function rowsEqualMap(rows: EnvRow[], map: Record<string, string>): boolean {
	const fromRows = rowsToMap(rows);
	const keys = Object.keys(fromRows);
	if (keys.length !== Object.keys(map).length) {
		return false;
	}
	return keys.every((key) => fromRows[key] === map[key]);
}

/**
 * Settings panel for hub-central custom env vars. Edits the GLOBAL scope and the
 * active project's scope; per-task vars are edited on the card. Saved via the
 * hub so the values reach agents on local and remote hosts alike. Values may be
 * secrets — they are masked by default and the config file is chmod 600 on disk.
 */
export function AgentEnvSettingsSection({ open, workspaceId }: AgentEnvSettingsSectionProps): JSX.Element {
	const { config, isLoading, isError, isSaving, save } = useAgentEnv(open);

	const projectMap = useMemo<Record<string, string>>(
		() => (workspaceId ? (config.projects[workspaceId] ?? {}) : {}),
		[config.projects, workspaceId],
	);

	const [globalRows, setGlobalRows] = useState<EnvRow[]>([]);
	const [projectRows, setProjectRows] = useState<EnvRow[]>([]);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Re-seed editor rows whenever the loaded config (or active project) changes.
	useEffect(() => {
		setGlobalRows(mapToRows(config.global));
	}, [config.global]);
	useEffect(() => {
		setProjectRows(mapToRows(projectMap));
	}, [projectMap]);

	const isDirty =
		!rowsEqualMap(globalRows, config.global) || (workspaceId !== null && !rowsEqualMap(projectRows, projectMap));

	const handleSave = async (): Promise<void> => {
		setSaveError(null);
		const nextProjects: AgentEnvConfig["projects"] = { ...config.projects };
		if (workspaceId) {
			const nextProjectMap = rowsToMap(projectRows);
			if (Object.keys(nextProjectMap).length > 0) {
				nextProjects[workspaceId] = nextProjectMap;
			} else {
				delete nextProjects[workspaceId];
			}
		}
		const nextConfig: AgentEnvConfig = {
			global: rowsToMap(globalRows),
			projects: nextProjects,
			tasks: config.tasks,
		};
		try {
			await save(nextConfig);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Could not save environment variables.");
		}
	};

	const controlsDisabled = isSaving || isLoading;

	return (
		<>
			<div data-settings-section="environment" />
			<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
				<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
					<KeyRound size={16} className="text-text-secondary" />
					Environment
				</h2>
			</div>
			<p className="text-text-secondary text-[13px] m-0 mb-3">
				Custom variables injected into every agent when a task starts (e.g. <code>GH_TOKEN</code> for{" "}
				<code>gh</code>, a Jira API key, or <code>ANTHROPIC_*</code> overrides for Claude Code). Stored on the hub
				and applied to local and remote tasks alike. Values may be secrets — they are kept in an owner-only config
				file and masked here.
			</p>

			{isLoading ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px] mb-4">
					<Spinner size={14} /> Loading…
				</div>
			) : null}
			{isError && !isLoading ? (
				<div className="rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px] text-text-primary mb-4">
					Could not load environment variables.
				</div>
			) : null}

			<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
				<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">Global</h6>
				<EnvVarsEditor
					rows={globalRows}
					onChange={setGlobalRows}
					disabled={controlsDisabled}
					emptyLabel="No global variables. These apply to every project and task."
				/>
			</div>

			<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
				<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
					Active project
				</h6>
				{workspaceId ? (
					<EnvVarsEditor
						rows={projectRows}
						onChange={setProjectRows}
						disabled={controlsDisabled}
						emptyLabel="No project variables. These override global vars for this project."
					/>
				) : (
					<p className="text-text-secondary text-[13px] m-0">Select a project to set project-scoped variables.</p>
				)}
			</div>

			{saveError ? (
				<div className="flex gap-2 rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px] mb-3">
					<span className="text-text-primary">{saveError}</span>
				</div>
			) : null}

			<div className="flex justify-end mb-2">
				<Button variant="primary" size="sm" onClick={handleSave} disabled={controlsDisabled || !isDirty}>
					{isSaving ? "Saving…" : "Save environment"}
				</Button>
			</div>
		</>
	);
}
