import * as Switch from "@radix-ui/react-switch";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceSkill } from "@/runtime/types";

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
	const [skills, setSkills] = useState<RuntimeWorkspaceSkill[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [installSource, setInstallSource] = useState("");
	const [isInstalling, setIsInstalling] = useState(false);
	const [pendingRemoveNames, setPendingRemoveNames] = useState<Set<string>>(new Set());
	const [pendingToggleNames, setPendingToggleNames] = useState<Set<string>>(new Set());
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

	const loadSkills = useCallback(async () => {
		if (!workspaceId) return;
		setIsLoading(true);
		try {
			const trpc = getRuntimeTrpcClient(workspaceId);
			const result = await trpc.workspace.skillsList.query();
			setSkills(result);
		} catch {
			setSkills([]);
		} finally {
			setIsLoading(false);
		}
	}, [workspaceId]);

	useEffect(() => {
		void loadSkills();
	}, [loadSkills]);

	const handleToggleDisabled = useCallback(
		async (skill: RuntimeWorkspaceSkill) => {
			if (!workspaceId || pendingToggleNames.has(skill.name)) return;
			setPendingToggleNames((prev) => new Set([...prev, skill.name]));
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				await trpc.workspace.skillsSetDisabled.mutate({
					name: skill.name,
					disabled: !skill.disabled,
				});
				await loadSkills();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({ message: `Failed to update skill: ${message}`, intent: "danger" });
			} finally {
				setPendingToggleNames((prev) => {
					const next = new Set(prev);
					next.delete(skill.name);
					return next;
				});
			}
		},
		[workspaceId, pendingToggleNames, loadSkills],
	);

	const handleRemove = useCallback(
		async (name: string) => {
			if (!workspaceId || pendingRemoveNames.has(name)) return;
			setPendingRemoveNames((prev) => new Set([...prev, name]));
			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				await trpc.workspace.skillsRemove.mutate({ name });
				await loadSkills();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({ message: `Failed to remove skill: ${message}`, intent: "danger" });
			} finally {
				setPendingRemoveNames((prev) => {
					const next = new Set(prev);
					next.delete(name);
					return next;
				});
			}
		},
		[workspaceId, pendingRemoveNames, loadSkills],
	);

	const handleInstall = useCallback(async () => {
		const source = installSource.trim();
		if (!source || !workspaceId) return;
		setIsInstalling(true);
		try {
			const trpc = getRuntimeTrpcClient(workspaceId);
			await trpc.workspace.skillsInstall.mutate({ source });
			setInstallSource("");
			await loadSkills();
			showAppToast({ message: "Skill installed successfully", intent: "success" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({ message: `Install failed: ${message}`, intent: "danger" });
		} finally {
			setIsInstalling(false);
		}
	}, [installSource, workspaceId, loadSkills]);

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
					placeholder="owner/repo or GitHub URL"
					value={installSource}
					onChange={(e) => setInstallSource(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !isInstalling) {
							void handleInstall();
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
				<div className="flex flex-col gap-1">
					{skills.map((skill) => (
						<div
							key={skill.name}
							className="flex items-center gap-3 rounded-md border border-border bg-surface-0 px-3 py-2"
						>
							<div className="flex-1 min-w-0">
								<p className="text-[13px] text-text-primary font-medium m-0 truncate">{skill.name}</p>
								{skill.description ? (
									<p className="text-[11px] text-text-secondary m-0 truncate">{skill.description}</p>
								) : null}
							</div>
							<Switch.Root
								checked={!skill.disabled}
								disabled={pendingToggleNames.has(skill.name)}
								onCheckedChange={() => void handleToggleDisabled(skill)}
								className="relative h-4 w-7 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								<Switch.Thumb className="block h-3 w-3 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[13px]" />
							</Switch.Root>
							<Button
								variant="ghost"
								size="sm"
								icon={<Trash2 size={14} />}
								onClick={() => void handleRemove(skill.name)}
								disabled={pendingRemoveNames.has(skill.name)}
								className="text-text-secondary hover:text-status-red flex-shrink-0"
							/>
						</div>
					))}
				</div>
			)}

			<CreateSkillDialog
				open={isCreateDialogOpen}
				onOpenChange={setIsCreateDialogOpen}
				onCreated={loadSkills}
				workspaceId={workspaceId}
			/>
		</div>
	);
}
