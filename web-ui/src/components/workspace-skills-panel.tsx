import * as Collapsible from "@radix-ui/react-collapsible";
import { parseSkillsShSource } from "@runtime-contract";
import { ChevronRight, ExternalLink, Plus, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { groupSkillsBySource, isSkillNew } from "@/components/skills/skill-grouping";
import { SkillNewBadge } from "@/components/skills/skill-new-badge";
import { SkillSwitch } from "@/components/skills/skill-switch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceSkill } from "@/runtime/types";
import { useWorkspaceSkills } from "@/runtime/workspace-skills-cache";

interface WorkspaceSkillsPanelProps {
	workspaceId: string | null;
}

function CreateSkillDialog({
	open,
	onOpenChange,
	onCreated,
	workspaceId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: () => void;
	workspaceId: string | null;
}): ReactElement {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const nameId = useId();
	const descriptionId = useId();
	const instructionsId = useId();

	useEffect(() => {
		if (!open) {
			setName("");
			setDescription("");
			setInstructions("");
		}
	}, [open]);

	const handleCreate = useCallback(async () => {
		if (!name.trim() || !instructions.trim() || !workspaceId) return;
		setIsSaving(true);
		try {
			const trpc = getRuntimeTrpcClient(workspaceId);
			await trpc.workspace.skillsCreate.mutate({
				name: name.trim(),
				description: description.trim() || undefined,
				instructions: instructions.trim(),
			});
			onCreated();
			onOpenChange(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({ message: `Failed to create skill: ${message}`, intent: "danger" });
		} finally {
			setIsSaving(false);
		}
	}, [name, description, instructions, workspaceId, onCreated, onOpenChange]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogHeader title="New Skill" />
			<DialogBody>
				<div className="flex flex-col gap-3">
					<div>
						<label htmlFor={nameId} className="text-[11px] text-text-secondary block mb-1">
							Name
						</label>
						<input
							id={nameId}
							type="text"
							className="w-full rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus"
							placeholder="my-skill"
							value={name}
							onChange={(e) => setName(e.target.value)}
							disabled={isSaving}
						/>
					</div>
					<div>
						<label htmlFor={descriptionId} className="text-[11px] text-text-secondary block mb-1">
							Description (optional)
						</label>
						<input
							id={descriptionId}
							type="text"
							className="w-full rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus"
							placeholder="What this skill does"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							disabled={isSaving}
						/>
					</div>
					<div>
						<label htmlFor={instructionsId} className="text-[11px] text-text-secondary block mb-1">
							Instructions
						</label>
						<textarea
							id={instructionsId}
							className="w-full rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus resize-y"
							placeholder="Paste your skill markdown here..."
							rows={10}
							value={instructions}
							onChange={(e) => setInstructions(e.target.value)}
							disabled={isSaving}
						/>
					</div>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={() => void handleCreate()}
					disabled={isSaving || !name.trim() || !instructions.trim()}
				>
					{isSaving ? <Spinner size={14} /> : null}
					Create
				</Button>
			</DialogFooter>
		</Dialog>
	);
}

export function WorkspaceSkillsPanel({ workspaceId }: WorkspaceSkillsPanelProps): ReactElement {
	const [installSource, setInstallSource] = useState("");
	const [isInstalling, setIsInstalling] = useState(false);
	const [installChoice, setInstallChoice] = useState<{ repo: string; skill: string } | null>(null);
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

	// Backed by the shared workspace-skills cache so the per-task picker reflects installs,
	// toggles, and removals made here (and vice versa) without a stale re-fetch.
	const { skills, isLoading, setSkills, refetch: loadSkills } = useWorkspaceSkills(workspaceId);

	// Optimistic so the UI feels instant: the `skills list` CLI is slow (1-2s), so we
	// update local state immediately and reconcile only on failure.
	const handleToggleDisabled = useCallback(
		async (skill: RuntimeWorkspaceSkill) => {
			if (!workspaceId) return;
			const nextDisabled = !skill.disabled;
			setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, disabled: nextDisabled } : s)));
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				await trpc.workspace.skillsSetDisabled.mutate({ name: skill.name, disabled: nextDisabled });
			} catch (error) {
				setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, disabled: skill.disabled } : s)));
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({ message: `Failed to update skill: ${message}`, intent: "danger" });
			}
		},
		[workspaceId],
	);

	// Enable/disable every skill in a source group at once.
	const handleToggleGroupDisabled = useCallback(
		async (groupSkills: RuntimeWorkspaceSkill[], nextDisabled: boolean) => {
			if (!workspaceId) return;
			const targets = groupSkills.filter((s) => s.disabled !== nextDisabled);
			if (targets.length === 0) return;
			const names = new Set(targets.map((s) => s.name));
			setSkills((prev) => prev.map((s) => (names.has(s.name) ? { ...s, disabled: nextDisabled } : s)));
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				await Promise.all(
					targets.map((s) => trpc.workspace.skillsSetDisabled.mutate({ name: s.name, disabled: nextDisabled })),
				);
			} catch (error) {
				setSkills((prev) => prev.map((s) => (names.has(s.name) ? { ...s, disabled: !nextDisabled } : s)));
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({ message: `Failed to update skills: ${message}`, intent: "danger" });
			}
		},
		[workspaceId],
	);

	const handleRemove = useCallback(
		async (name: string) => {
			if (!workspaceId) return;
			const previous = skills;
			setSkills((prev) => prev.filter((s) => s.name !== name));
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				await trpc.workspace.skillsRemove.mutate({ name });
			} catch (error) {
				setSkills(previous);
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({ message: `Failed to remove skill: ${message}`, intent: "danger" });
			}
		},
		[workspaceId, skills],
	);

	const performInstall = useCallback(
		async (source: string, skills?: string[]) => {
			if (!source || !workspaceId) return;
			setIsInstalling(true);
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				await trpc.workspace.skillsInstall.mutate(skills ? { source, skills } : { source });
				setInstallSource("");
				setInstallChoice(null);
				await loadSkills();
				showAppToast({ message: "Skill installed successfully", intent: "success" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({ message: `Install failed: ${message}`, intent: "danger" });
			} finally {
				setIsInstalling(false);
			}
		},
		[workspaceId, loadSkills],
	);

	const handleInstall = useCallback(() => {
		const source = installSource.trim();
		if (!source || !workspaceId) return;
		const { repo, skill } = parseSkillsShSource(source);
		// When the source names a specific skill, let the user pick that one or the whole collection.
		if (skill) {
			setInstallChoice({ repo, skill });
			return;
		}
		void performInstall(repo);
	}, [installSource, workspaceId, performInstall]);

	const skillGroups = useMemo(() => groupSkillsBySource(skills), [skills]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0">Skills</h6>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						icon={<ExternalLink size={14} />}
						onClick={() => window.open("https://skills.sh", "_blank")}
					>
						Browse skills.sh
					</Button>
					<Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => setIsCreateDialogOpen(true)}>
						New
					</Button>
				</div>
			</div>

			<div className="flex gap-2">
				<input
					type="text"
					className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus"
					placeholder="owner/repo, GitHub URL, or skills.sh URL"
					value={installSource}
					onChange={(e) => setInstallSource(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !isInstalling) {
							handleInstall();
						}
					}}
					disabled={isInstalling}
				/>
				<Button
					variant="primary"
					size="sm"
					onClick={() => void handleInstall()}
					disabled={isInstalling || !installSource.trim()}
				>
					{isInstalling ? <Spinner size={14} /> : null}
					Install
				</Button>
			</div>

			{isLoading ? (
				<div className="flex items-center justify-center py-4">
					<Spinner size={16} />
				</div>
			) : skills.length === 0 ? (
				<p className="text-text-secondary text-[13px] text-center py-3">
					No skills installed. Install one from skills.sh or create your own.
				</p>
			) : (
				<div className="flex flex-col gap-3">
					{skillGroups.map((group) => {
						const allEnabled = group.skills.every((s) => !s.disabled);
						return (
							<Collapsible.Root key={group.label} defaultOpen className="flex flex-col gap-1">
								<div className="flex items-center gap-2">
									<Collapsible.Trigger className="group flex flex-1 items-center gap-1.5 min-w-0 text-left text-[11px] font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary">
										<ChevronRight
											size={12}
											className="flex-shrink-0 transition-transform group-data-[state=open]:rotate-90"
										/>
										<span className="truncate">{group.label}</span>
										<span className="text-text-tertiary font-normal normal-case tracking-normal">
											{group.skills.length}
										</span>
									</Collapsible.Trigger>
									<SkillSwitch
										checked={allEnabled}
										onCheckedChange={(next) => void handleToggleGroupDisabled(group.skills, !next)}
									/>
								</div>
								<Collapsible.Content className="flex flex-col gap-1 pt-0.5">
									{group.skills.map((skill) => (
										<div
											key={skill.name}
											className="flex items-center gap-3 rounded-md border border-border bg-surface-0 px-3 py-2"
										>
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-1.5 min-w-0">
													<p className="text-[13px] text-text-primary font-medium m-0 truncate">
														{skill.name}
													</p>
													{isSkillNew(skill) ? <SkillNewBadge /> : null}
												</div>
												{skill.description ? (
													<Tooltip
														content={skill.description}
														className="max-w-xs whitespace-normal break-words"
													>
														<p className="text-[11px] text-text-secondary m-0 truncate cursor-help">
															{skill.description}
														</p>
													</Tooltip>
												) : null}
											</div>
											<SkillSwitch
												checked={!skill.disabled}
												onCheckedChange={() => void handleToggleDisabled(skill)}
											/>
											<Button
												variant="ghost"
												size="sm"
												icon={<Trash2 size={14} />}
												onClick={() => void handleRemove(skill.name)}
												className="text-text-secondary hover:text-status-red flex-shrink-0"
											/>
										</div>
									))}
								</Collapsible.Content>
							</Collapsible.Root>
						);
					})}
				</div>
			)}

			<InstallChoiceDialog
				choice={installChoice}
				isInstalling={isInstalling}
				onCancel={() => setInstallChoice(null)}
				onInstallSkill={(repo, skill) => void performInstall(repo, [skill])}
				onInstallCollection={(repo) => void performInstall(repo)}
			/>

			<CreateSkillDialog
				open={isCreateDialogOpen}
				onOpenChange={setIsCreateDialogOpen}
				onCreated={loadSkills}
				workspaceId={workspaceId}
			/>
		</div>
	);
}

function InstallChoiceDialog({
	choice,
	isInstalling,
	onCancel,
	onInstallSkill,
	onInstallCollection,
}: {
	choice: { repo: string; skill: string } | null;
	isInstalling: boolean;
	onCancel: () => void;
	onInstallSkill: (repo: string, skill: string) => void;
	onInstallCollection: (repo: string) => void;
}): ReactElement | null {
	if (!choice) {
		return null;
	}
	return (
		<Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
			<DialogHeader title="Install skill" />
			<DialogBody>
				<p className="text-[13px] text-text-secondary m-0">
					<span className="text-text-primary font-medium">{choice.skill}</span> is part of the{" "}
					<span className="text-text-primary font-medium">{choice.repo}</span> collection. Install just this skill,
					or the whole collection?
				</p>
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onCancel} disabled={isInstalling}>
					Cancel
				</Button>
				<Button variant="default" onClick={() => onInstallCollection(choice.repo)} disabled={isInstalling}>
					Whole collection
				</Button>
				<Button variant="primary" onClick={() => onInstallSkill(choice.repo, choice.skill)} disabled={isInstalling}>
					{isInstalling ? <Spinner size={14} /> : null}
					Just {choice.skill}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
