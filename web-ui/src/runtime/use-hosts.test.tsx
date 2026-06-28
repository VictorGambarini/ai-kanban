import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseHostsResult, useHosts } from "@/runtime/use-hosts";

const listQuery = vi.hoisted(() => vi.fn());
const updateMutate = vi.hoisted(() => vi.fn());
const removeMutate = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getHubTrpcClient: () => ({
		hosts: {
			list: { query: listQuery },
			update: { mutate: updateMutate },
			remove: { mutate: removeMutate },
			add: { mutate: vi.fn() },
			connect: { mutate: vi.fn() },
			disconnect: { mutate: vi.fn() },
		},
	}),
}));

function HookHarness({ onSnapshot }: { onSnapshot: (result: UseHostsResult) => void }): null {
	const result = useHosts();
	useEffect(() => {
		onSnapshot(result);
	});
	return null;
}

describe("useHosts.updateHost", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		listQuery.mockReset();
		updateMutate.mockReset();
		removeMutate.mockReset();
		listQuery.mockResolvedValue({ hosts: [] });
		updateMutate.mockResolvedValue({ host: { id: "van-one" }, status: null });
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("sends the patch to hosts.update and refreshes the list", async () => {
		let latest: UseHostsResult | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(result) => {
						latest = result;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (latest === null) {
			throw new Error("Expected a hook snapshot.");
		}

		const callsBeforeUpdate = listQuery.mock.calls.length;

		await act(async () => {
			await (latest as UseHostsResult).updateHost("van-one", {
				label: "Renamed",
				ssh: { hostname: "10.0.0.9" },
			});
		});

		expect(updateMutate).toHaveBeenCalledWith({
			hostId: "van-one",
			patch: { label: "Renamed", ssh: { hostname: "10.0.0.9" } },
		});
		// updateHost must re-fetch the list so the UI reflects the change.
		expect(listQuery.mock.calls.length).toBeGreaterThan(callsBeforeUpdate);
	});
});
