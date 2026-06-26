import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronsUpDown, Monitor, Plus, Server, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getActiveHostId, LOCAL_HOST_ID, setActiveHostId } from "@/runtime/active-host";
import { type RegisterHostInput, type RemoteHostSummary, useHosts } from "@/runtime/use-hosts";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

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

function StatusDot({ state }: { state: ConnectionState | null | undefined }): React.ReactElement {
	return (
		<span
			className={cn("inline-block h-2 w-2 shrink-0 rounded-full", statusDotClass(state))}
			title={statusLabel(state)}
		/>
	);
}

/**
 * Sidebar control for picking which machine ("host") the board is scoped to:
 * the local hub or a remote van reached over SSH. Selecting a host re-scopes the
 * whole app (via {@link setActiveHostId}, which reloads).
 */
export function HostSwitcher(): React.ReactElement | null {
	const { hosts, error, addHost, removeHost, connectHost } = useHosts();
	const [isAddOpen, setIsAddOpen] = useState(false);
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
						className="z-50 min-w-[220px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
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
								onConnect={() => {
									void connectHost(entry.host.id).catch((caught) =>
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
	onConnect,
	onRemove,
}: {
	summary: RemoteHostSummary;
	isActive: boolean;
	onSelect: () => void;
	onConnect: () => void;
	onRemove: () => void;
}): React.ReactElement {
	const state = (summary.status?.state ?? null) as ConnectionState | null;
	return (
		<div className="group flex items-center gap-1 rounded-sm px-1 hover:bg-surface-3">
			<button
				type="button"
				onClick={onSelect}
				className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1.5 text-left text-[13px] text-text-primary"
			>
				<StatusDot state={state} />
				<Server size={13} className="shrink-0 text-text-secondary" />
				<span className="min-w-0 flex-1 truncate">{summary.host.label}</span>
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
			<button
				type="button"
				onClick={onRemove}
				title="Remove host"
				className="shrink-0 rounded-sm p-1 text-text-tertiary opacity-0 hover:text-status-red group-hover:opacity-100"
			>
				<Trash2 size={13} />
			</button>
		</div>
	);
}

const inputClass =
	"w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none";

function AddHostDialog({
	open,
	onOpenChange,
	addHost,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	addHost: (input: RegisterHostInput) => Promise<RemoteHostSummary>;
}): React.ReactElement {
	const [label, setLabel] = useState("");
	const [hostname, setHostname] = useState("");
	const [username, setUsername] = useState("");
	const [sshPort, setSshPort] = useState("");
	const [identity, setIdentity] = useState("");
	const [useAgent, setUseAgent] = useState(false);
	const [runtimePort, setRuntimePort] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const reset = () => {
		setLabel("");
		setHostname("");
		setUsername("");
		setSshPort("");
		setIdentity("");
		setUseAgent(false);
		setRuntimePort("");
	};

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		if (submitting || !hostname.trim() || !username.trim()) {
			return;
		}
		setSubmitting(true);
		try {
			const added = await addHost({
				label: label.trim() || hostname.trim(),
				ssh: {
					hostname: hostname.trim(),
					username: username.trim(),
					port: sshPort.trim() ? Number.parseInt(sshPort, 10) : undefined,
					privateKeyPath: identity.trim() || undefined,
					useAgent: useAgent || undefined,
				},
				runtimePort: runtimePort.trim() ? Number.parseInt(runtimePort, 10) : undefined,
			});
			reset();
			onOpenChange(false);
			// Jump straight to the newly added host.
			setActiveHostId(added.host.id);
		} catch (caught) {
			notifyError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogHeader title="Add remote host" />
			<form onSubmit={(event) => void handleSubmit(event)}>
				<DialogBody className="flex flex-col gap-3">
					<Field label="SSH host" hint="Hostname or IP">
						<input
							className={inputClass}
							value={hostname}
							onChange={(e) => setHostname(e.target.value)}
							placeholder="10.0.0.5"
						/>
					</Field>
					<Field label="SSH user">
						<input
							className={inputClass}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							placeholder="agent"
						/>
					</Field>
					<Field label="Label" hint="Optional">
						<input
							className={inputClass}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="van-one"
						/>
					</Field>
					<div className="grid grid-cols-2 gap-3">
						<Field label="SSH port" hint="Default 22">
							<input
								className={inputClass}
								value={sshPort}
								onChange={(e) => setSshPort(e.target.value)}
								placeholder="22"
								inputMode="numeric"
							/>
						</Field>
						<Field label="Runtime port" hint="Default 3484">
							<input
								className={inputClass}
								value={runtimePort}
								onChange={(e) => setRuntimePort(e.target.value)}
								placeholder="3484"
								inputMode="numeric"
							/>
						</Field>
					</div>
					<Field label="Identity file" hint="Private key path (never stored)">
						<input
							className={inputClass}
							value={identity}
							onChange={(e) => setIdentity(e.target.value)}
							placeholder="~/.ssh/id_ed25519"
						/>
					</Field>
					<label className="flex items-center gap-2 text-sm text-text-secondary">
						<input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} />
						Use local SSH agent (SSH_AUTH_SOCK)
					</label>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="default" onClick={() => onOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" disabled={submitting || !hostname.trim() || !username.trim()}>
						{submitting ? <Spinner size={14} /> : null}
						Add host
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
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
