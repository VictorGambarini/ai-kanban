import { type ReactElement, useEffect, useState } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import { LOCAL_HOST_ID } from "@/runtime/active-host";
import { getHubTrpcClient } from "@/runtime/trpc-client";
import { useHosts } from "@/runtime/use-hosts";

const LOCAL_TARGET_VALUE = "local";

export interface DockerSandboxProfileOption {
	id: string;
	label: string;
}

/** Docker sandbox profiles are hub-central config; fetch them via the hub client. */
function useDockerSandboxProfiles(): DockerSandboxProfileOption[] {
	const [profiles, setProfiles] = useState<DockerSandboxProfileOption[]>([]);
	useEffect(() => {
		let cancelled = false;
		void getHubTrpcClient()
			.runtime.getDockerSandboxProfiles.query()
			.then((response) => {
				if (!cancelled) {
					setProfiles(response.profiles.map((profile) => ({ id: profile.id, label: profile.label })));
				}
			})
			.catch(() => {
				// No profiles configured / hub unreachable — the Docker group simply won't render.
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return profiles;
}

/**
 * Picks where a task executes: the local hub, a registered SSH host, or a Docker
 * sandbox profile. The value is the card's `runtimeTarget` string (`"local"` when
 * undefined). Docker options are disabled for the in-process Cline agent, which
 * has no exec boundary to run inside a sandbox.
 */
export function RuntimeTargetSelector({
	value,
	onChange,
	dockerProfiles,
	isClineAgent = false,
	disabled = false,
}: {
	value: string | undefined;
	onChange: (value: string | undefined) => void;
	/** Overrides the hub-fetched profiles (mainly for tests). */
	dockerProfiles?: DockerSandboxProfileOption[];
	isClineAgent?: boolean;
	disabled?: boolean;
}): ReactElement {
	const { hosts } = useHosts();
	const fetchedDockerProfiles = useDockerSandboxProfiles();
	const profiles = dockerProfiles ?? fetchedDockerProfiles;
	const selectValue = value?.trim() ? value.trim() : LOCAL_TARGET_VALUE;

	return (
		<div className="pt-2 flex flex-col gap-1">
			<span className="text-[11px] text-text-secondary block mb-1">Runtime</span>
			<NativeSelect
				size="sm"
				fill
				value={selectValue}
				disabled={disabled}
				onChange={(event) => {
					const next = event.currentTarget.value;
					onChange(next === LOCAL_TARGET_VALUE ? undefined : next);
				}}
			>
				<option value={LOCAL_TARGET_VALUE}>Local (this machine)</option>
				{hosts.length > 0 ? (
					<optgroup label="Remote hosts">
						{hosts.map((entry) => {
							const state = entry.host.id === LOCAL_HOST_ID ? "connected" : entry.status?.state;
							const suffix = state === "connected" ? "" : ` (${state ?? "disconnected"})`;
							return (
								<option key={entry.host.id} value={`ssh:${entry.host.id}`}>
									{entry.host.label}
									{suffix}
								</option>
							);
						})}
					</optgroup>
				) : null}
				{profiles.length > 0 ? (
					<optgroup label="Docker sandboxes">
						{profiles.map((profile) => (
							<option key={profile.id} value={`docker:${profile.id}`} disabled={isClineAgent}>
								{profile.label}
								{isClineAgent ? " (unavailable for Cline)" : ""}
							</option>
						))}
					</optgroup>
				) : null}
			</NativeSelect>
		</div>
	);
}
