import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AlertTriangle, Check, ChevronsUpDown, Monitor, Pencil, Plus, RotateCw, Server, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getActiveHostId, LOCAL_HOST_ID, setActiveHostId } from "@/runtime/active-host";
import { type RegisterHostInput, type RemoteHostSummary, type UpdateHostInput, useHosts } from "@/runtime/use-hosts";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Version of this hub's build, injected by Vite — compared against each remote runtime. */
const HUB_VERSION = __APP_VERSION__;

function statusDotClass(state: ConnectionState | null | undefined): string {
	switch (state) {
		case "connected":
			return "bg-status-green";
		case "connecting":
			return "bg-status-orange";
		case "error":
			return "bg-status-red";
		default:
			return "bg-text-tertiary";
	}
}

function statusLabel(state: ConnectionState | null | undefined): string {
	switch (state) {
		case "connected":
			return "Connected";
		case "connecting":
			return "Connecting…";
		case "error":
			return "Error";
		default:
			return "Disconnected";
	}
}

function StatusDot({
	state,
	title,
}: {
	state: ConnectionState | null | undefined;
	title?: string;
}): React.ReactElement {
	return (
		<span
			className={cn("inline-block h-2 w-2 shrink-0 rounded-full", statusDotClass(state))}
			title={title ?? statusLabel(state)}
		/>
	);
}

/**
 * Sidebar control for picking which machine ("host") the board is scoped to:
 * the local hub or a remote VM reached over SSH. Selecting a host re-scopes the
 * whole app (via {@link setActiveHostId}, which reloads).
 */
export function HostSwitcher(): React.ReactElement | null {
	const { hosts, error, addHost, updateHost, removeHost, connectHost, restartHost } = useHosts();
	const [isAddOpen, setIsAddOpen] = useState(false);
	const [editing, setEditing] = useState<RemoteHostSummary | null>(null);
	const activeHostId = getActiveHostId();

	// Hide entirely until there's something to manage, so single-machine users
	// never see multi-host UI. The "Add host" affordance lives in the menu, which
	// is reachable as soon as one host exists — but we also surface it when the
	// active host is remote so it can always be switched back.
	const hasRemoteContext = hosts.length > 0 || activeHostId !== LOCAL_HOST_ID;
	if (!hasRemoteContext && !error) {
		return (
			<div className="px-3 pb-1">
				<button
					type="button"
					onClick={() => setIsAddOpen(true)}
					className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary hover:border-border-bright"
				>
					<Plus size={12} className="shrink-0" />
					Add remote host
				</button>
				<AddHostDialog open={isAddOpen} onOpenChange={setIsAddOpen} addHost={addHost} />
			</div>
		);
	}

	const activeSummary = hosts.find((entry) => entry.host.id === activeHostId);
	const activeLabel = activeHostId === LOCAL_HOST_ID ? "Local" : (activeSummary?.host.label ?? activeHostId);
	const activeState = activeHostId === LOCAL_HOST_ID ? "connected" : (activeSummary?.status?.state ?? null);

	return (
		<div className="px-3 pb-1">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-left hover:border-border-bright"
					>
						{activeHostId === LOCAL_HOST_ID ? (
							<Monitor size={14} className="shrink-0 text-text-secondary" />
						) : (
							<StatusDot state={activeState as ConnectionState} />
						)}
						<span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">{activeLabel}</span>
						<ChevronsUpDown size={12} className="shrink-0 text-text-tertiary" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						side="bottom"
						align="start"
						sideOffset={4}
						className="z-50 min-w-[240px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
					>
						<HostMenuItem
							label="Local (this machine)"
							icon={<Monitor size={14} className="shrink-0 text-text-secondary" />}
							isActive={activeHostId === LOCAL_HOST_ID}
							onSelect={() => setActiveHostId(LOCAL_HOST_ID)}
						/>
						{hosts.length > 0 ? <DropdownMenu.Separator className="my-1 h-px bg-border" /> : null}
						{hosts.map((entry) => (
							<RemoteHostMenuItem
								key={entry.host.id}
								summary={entry}
								isActive={entry.host.id === activeHostId}
								onSelect={() => setActiveHostId(entry.host.id)}
								onEdit={() => setEditing(entry)}
								onConnect={() => {
									void connectHost(entry.host.id).catch((caught) =>
										notifyError(caught instanceof Error ? caught.message : String(caught)),
									);
								}}
								onRestart={() => {
									void restartHost(entry.host.id).catch((caught) =>
										notifyError(caught instanceof Error ? caught.message : String(caught)),
									);
								}}
								onRemove={() => {
									void removeHost(entry.host.id).catch((caught) =>
										notifyError(caught instanceof Error ? caught.message : String(caught)),
									);
								}}
							/>
						))}
						<DropdownMenu.Separator className="my-1 h-px bg-border" />
						<DropdownMenu.Item
							className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-secondary outline-none data-[highlighted]:bg-surface-3"
							onSelect={(event) => {
								event.preventDefault();
								setIsAddOpen(true);
							}}
						>
							<Plus size={14} className="shrink-0" />
							Add remote host…
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<AddHostDialog open={isAddOpen} onOpenChange={setIsAddOpen} addHost={addHost} />
			<EditHostDialog
				summary={editing}
				onOpenChange={(open) => {
					if (!open) {
						setEditing(null);
					}
				}}
				updateHost={updateHost}
			/>
		</div>
	);
}

function HostMenuItem({
	label,
	icon,
	isActive,
	onSelect,
}: {
	label: string;
	icon: React.ReactNode;
	isActive: boolean;
	onSelect: () => void;
}): React.ReactElement {
	return (
		<DropdownMenu.Item
			className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-primary outline-none data-[highlighted]:bg-surface-3"
			onSelect={onSelect}
		>
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{isActive ? <Check size={14} className="shrink-0 text-accent" /> : null}
		</DropdownMenu.Item>
	);
}

function RemoteHostMenuItem({
	summary,
	isActive,
	onSelect,
	onEdit,
	onConnect,
	onRestart,
	onRemove,
}: {
	summary: RemoteHostSummary;
	isActive: boolean;
	onSelect: () => void;
	onEdit: () => void;
	onConnect: () => void;
	onRestart: () => void;
	onRemove: () => void;
}): React.ReactElement {
	const sshState = (summary.status?.state ?? null) as ConnectionState | null;
	// SSH-level failure takes priority; otherwise a runtime that never started
	// even though the tunnel is up (e.g. the host has no npx).
	const problem = (sshState === "error" ? summary.status?.error : null) ?? summary.runtimeError ?? null;
	// A host whose runtime failed is unusable even with SSH "connected", so show it as an error.
	const state: ConnectionState | null = problem && sshState === "connected" ? "error" : sshState;
	const remoteVersion = summary.runtimeVersion;
	const versionMismatch = remoteVersion !== null && remoteVersion !== HUB_VERSION;
	return (
		<div className="group rounded-sm px-1 hover:bg-surface-3">
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={onSelect}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1.5 text-left text-[13px] text-text-primary"
				>
					<StatusDot state={state} title={problem ?? undefined} />
					<Server size={13} className="shrink-0 text-text-secondary" />
					<span className="min-w-0 truncate">{summary.host.label}</span>
					{remoteVersion ? (
						<span
							className={cn("shrink-0 text-[10px]", versionMismatch ? "text-status-gold" : "text-text-tertiary")}
							title={
								versionMismatch
									? `Remote runs v${remoteVersion}, hub runs v${HUB_VERSION} — versions may be incompatible.`
									: `Remote runs v${remoteVersion}`
							}
						>
							{versionMismatch ? <AlertTriangle size={10} className="mr-0.5 inline" /> : null}v{remoteVersion}
						</span>
					) : null}
					<span className="min-w-0 flex-1" />
					{isActive ? <Check size={14} className="shrink-0 text-accent" /> : null}
				</button>
				{state === "error" || state === "disconnected" ? (
					<button
						type="button"
						onClick={onConnect}
						title="Reconnect"
						className="shrink-0 rounded-sm px-1 py-0.5 text-[11px] text-text-tertiary hover:text-text-secondary"
					>
						Retry
					</button>
				) : null}
				{state === "connected" ? (
					<button
						type="button"
						onClick={onRestart}
						title="Restart runtime (re-detects installed agents)"
						className="shrink-0 rounded-sm p-1 text-text-tertiary opacity-0 hover:text-text-primary group-hover:opacity-100"
					>
						<RotateCw size={13} />
					</button>
				) : null}
				<button
					type="button"
					onClick={onEdit}
					title="Edit host"
					className="shrink-0 rounded-sm p-1 text-text-tertiary opacity-0 hover:text-text-primary group-hover:opacity-100"
				>
					<Pencil size={13} />
				</button>
				<button
					type="button"
					onClick={onRemove}
					title="Remove host"
					className="shrink-0 rounded-sm p-1 text-text-tertiary opacity-0 hover:text-status-red group-hover:opacity-100"
				>
					<Trash2 size={13} />
				</button>
			</div>
			{problem ? (
				<p className="px-1 pb-1 text-[11px] leading-snug text-status-red" title={problem}>
					{problem}
				</p>
			) : null}
		</div>
	);
}

const inputClass =
	"w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none";

interface HostFormValues {
	label: string;
	hostname: string;
	username: string;
	sshPort: string;
	identity: string;
	useAgent: boolean;
	runtimePort: string;
}

const emptyFormValues: HostFormValues = {
	label: "",
	hostname: "",
	username: "",
	sshPort: "",
	identity: "",
	useAgent: false,
	runtimePort: "",
};

function summaryToFormValues(summary: RemoteHostSummary): HostFormValues {
	const { host } = summary;
	return {
		label: host.label,
		hostname: host.ssh.hostname,
		username: host.ssh.username,
		sshPort: host.ssh.port ? String(host.ssh.port) : "",
		identity: host.ssh.privateKeyPath ?? "",
		useAgent: host.ssh.useAgent ?? false,
		runtimePort: host.runtimePort ? String(host.runtimePort) : "",
	};
}

/** Shared add/edit form. The dialog chrome and submit semantics are owned by callers. */
function HostFormDialog({
	open,
	onOpenChange,
	title,
	submitLabel,
	initialValues,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	submitLabel: string;
	initialValues: HostFormValues;
	onSubmit: (values: HostFormValues) => Promise<void>;
}): React.ReactElement {
	const [values, setValues] = useState<HostFormValues>(initialValues);
	const [submitting, setSubmitting] = useState(false);

	const set = <Key extends keyof HostFormValues>(key: Key, value: HostFormValues[Key]) => {
		setValues((current) => ({ ...current, [key]: value }));
	};

	const canSubmit = !submitting && values.hostname.trim().length > 0 && values.username.trim().length > 0;

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		if (!canSubmit) {
			return;
		}
		setSubmitting(true);
		try {
			await onSubmit(values);
			onOpenChange(false);
		} catch (caught) {
			notifyError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogHeader title={title} />
			<form onSubmit={(event) => void handleSubmit(event)}>
				<DialogBody className="flex flex-col gap-3">
					<Field label="SSH host" hint="Hostname or IP">
						<input
							className={inputClass}
							value={values.hostname}
							onChange={(e) => set("hostname", e.target.value)}
							placeholder="10.0.0.5"
						/>
					</Field>
					<Field label="SSH user">
						<input
							className={inputClass}
							value={values.username}
							onChange={(e) => set("username", e.target.value)}
							placeholder="agent"
						/>
					</Field>
					<Field label="Label" hint="Optional">
						<input
							className={inputClass}
							value={values.label}
							onChange={(e) => set("label", e.target.value)}
							placeholder="vm-one"
						/>
					</Field>
					<div className="grid grid-cols-2 gap-3">
						<Field label="SSH port" hint="Default 22">
							<input
								className={inputClass}
								value={values.sshPort}
								onChange={(e) => set("sshPort", e.target.value)}
								placeholder="22"
								inputMode="numeric"
							/>
						</Field>
						<Field label="Runtime port" hint="Default 3484">
							<input
								className={inputClass}
								value={values.runtimePort}
								onChange={(e) => set("runtimePort", e.target.value)}
								placeholder="3484"
								inputMode="numeric"
							/>
						</Field>
					</div>
					<Field label="Identity file" hint="Private key path (~ is allowed; never stored)">
						<input
							className={inputClass}
							value={values.identity}
							onChange={(e) => set("identity", e.target.value)}
							placeholder="~/.ssh/id_ed25519"
						/>
					</Field>
					<label className="flex items-center gap-2 text-sm text-text-secondary">
						<input
							type="checkbox"
							checked={values.useAgent}
							onChange={(e) => set("useAgent", e.target.checked)}
						/>
						Use local SSH agent (SSH_AUTH_SOCK)
					</label>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="default" onClick={() => onOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" disabled={!canSubmit}>
						{submitting ? <Spinner size={14} /> : null}
						{submitLabel}
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}

function AddHostDialog({
	open,
	onOpenChange,
	addHost,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	addHost: (input: RegisterHostInput) => Promise<RemoteHostSummary>;
}): React.ReactElement | null {
	if (!open) {
		return null;
	}
	return (
		<HostFormDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Add remote host"
			submitLabel="Add host"
			initialValues={emptyFormValues}
			onSubmit={async (values) => {
				const added = await addHost({
					label: values.label.trim() || values.hostname.trim(),
					ssh: buildSshInput(values),
					runtimePort: parsePort(values.runtimePort),
				});
				// Jump straight to the newly added host.
				setActiveHostId(added.host.id);
			}}
		/>
	);
}

function EditHostDialog({
	summary,
	onOpenChange,
	updateHost,
}: {
	summary: RemoteHostSummary | null;
	onOpenChange: (open: boolean) => void;
	updateHost: (hostId: string, patch: UpdateHostInput) => Promise<RemoteHostSummary | null>;
}): React.ReactElement | null {
	if (!summary) {
		return null;
	}
	return (
		<HostFormDialog
			open
			onOpenChange={onOpenChange}
			title={`Edit ${summary.host.label}`}
			submitLabel="Save changes"
			initialValues={summaryToFormValues(summary)}
			onSubmit={async (values) => {
				await updateHost(summary.host.id, {
					label: values.label.trim() || values.hostname.trim(),
					ssh: buildSshInput(values),
					runtimePort: parsePort(values.runtimePort),
				});
			}}
		/>
	);
}

function parsePort(value: string): number | undefined {
	const trimmed = value.trim();
	return trimmed ? Number.parseInt(trimmed, 10) : undefined;
}

/**
 * Build the ssh payload, omitting empty optional fields so an update never
 * clobbers a stored key path / port with an empty value.
 */
function buildSshInput(values: HostFormValues): RegisterHostInput["ssh"] {
	return {
		hostname: values.hostname.trim(),
		username: values.username.trim(),
		port: parsePort(values.sshPort),
		privateKeyPath: values.identity.trim() || undefined,
		useAgent: values.useAgent || undefined,
	};
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs font-medium text-text-secondary">
				{label}
				{hint ? <span className="ml-1 font-normal text-text-tertiary">· {hint}</span> : null}
			</span>
			{children}
		</div>
	);
}
