import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activeHostHeaders,
	applyActiveHostToUrl,
	getActiveHostId,
	isLocalActiveHost,
	LOCAL_HOST_ID,
	setActiveHostId,
} from "@/runtime/active-host";
import { LocalStorageKey } from "@/storage/local-storage-store";

const noopReload = () => {};

afterEach(() => {
	// Reset module state back to local between tests.
	setActiveHostId(LOCAL_HOST_ID, noopReload);
	window.localStorage.clear();
});

describe("active-host", () => {
	it("defaults to local with no header and no url mutation", () => {
		expect(getActiveHostId()).toBe(LOCAL_HOST_ID);
		expect(isLocalActiveHost()).toBe(true);
		expect(activeHostHeaders()).toEqual({});
		const url = new URL("ws://host/api/terminal/io?taskId=t");
		applyActiveHostToUrl(url);
		expect(url.searchParams.has("hostId")).toBe(false);
	});

	it("selecting a remote host sets the header, url param, and persists", () => {
		const reload = vi.fn();
		setActiveHostId("van-one", reload);

		expect(getActiveHostId()).toBe("van-one");
		expect(isLocalActiveHost()).toBe(false);
		expect(activeHostHeaders()).toEqual({ "x-kanban-host-id": "van-one" });
		expect(window.localStorage.getItem(LocalStorageKey.ActiveHostId)).toBe("van-one");
		expect(reload).toHaveBeenCalledTimes(1);

		const url = new URL("ws://host/api/runtime/ws?workspaceId=w");
		applyActiveHostToUrl(url);
		expect(url.searchParams.get("hostId")).toBe("van-one");
	});

	it("switching back to local clears the stored id", () => {
		setActiveHostId("van-one", noopReload);
		setActiveHostId(LOCAL_HOST_ID, noopReload);
		expect(getActiveHostId()).toBe(LOCAL_HOST_ID);
		expect(window.localStorage.getItem(LocalStorageKey.ActiveHostId)).toBeNull();
	});

	it("does not reload when the host is unchanged", () => {
		const reload = vi.fn();
		setActiveHostId(LOCAL_HOST_ID, reload);
		expect(reload).not.toHaveBeenCalled();
	});
});
