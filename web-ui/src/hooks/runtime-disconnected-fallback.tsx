import { AlertCircle } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { getActiveHostId, isLocalActiveHost, LOCAL_HOST_ID, setActiveHostId } from "@/runtime/active-host";

export function RuntimeDisconnectedFallback(): ReactElement {
	// A disconnect while a remote host is active almost always means the remote
	// "van" is unreachable, not that the local hub died — so the local guidance
	// ("run cline again in your terminal") is wrong, and there'd otherwise be no
	// way back: the host switcher lives in the app shell this fallback replaces.
	// Offer an explicit escape hatch back to the local hub.
	const isLocal = isLocalActiveHost();
	const activeHostId = getActiveHostId();

	return (
		<div
			style={{
				display: "flex",
				height: "100svh",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--color-surface-0)",
				padding: "24px",
			}}
		>
			<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
				<AlertCircle size={48} />
				<h3 className="font-semibold text-text-primary">
					{isLocal ? "Disconnected from Cline" : "Can't reach remote host"}
				</h3>
				{isLocal ? (
					<p className="text-text-secondary">Run cline again in your terminal, then reload this tab.</p>
				) : (
					<>
						<p className="max-w-sm text-center text-text-secondary">
							The remote host <span className="font-medium text-text-primary">{activeHostId}</span> is
							unreachable. Switch back to the local hub, or check that the host is online and reachable over SSH.
						</p>
						<Button variant="primary" onClick={() => setActiveHostId(LOCAL_HOST_ID)}>
							Switch to local hub
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
