import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTerminalSnapshotStore } from "../../../src/terminal/terminal-snapshot-store";
import { createTempDir } from "../../utilities/temp-dir";

const { renameControl } = vi.hoisted(() => ({
	renameControl: { failNext: null as null | Error },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			if (renameControl.failNext) {
				const error = renameControl.failNext;
				renameControl.failNext = null;
				throw error;
			}
			return actual.rename(...args);
		},
	};
});

function createSnapshot(
	overrides: {
		snapshot?: string;
		cols?: number;
		rows?: number;
		savedAt?: number;
		sessionStartedAt?: number | null;
	} = {},
) {
	return {
		version: 1 as const,
		snapshot: overrides.snapshot ?? "hello from scrollback",
		cols: overrides.cols ?? 80,
		rows: overrides.rows ?? 24,
		savedAt: overrides.savedAt ?? 1,
		sessionStartedAt: overrides.sessionStartedAt ?? null,
	};
}

describe("createTerminalSnapshotStore", () => {
	it("round-trips a snapshot through save and load", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });
			const snapshot = createSnapshot({
				snapshot: "hello",
				cols: 100,
				rows: 30,
				savedAt: 123,
				sessionStartedAt: 100,
			});

			await store.save("task-1", snapshot);
			const loaded = await store.load("task-1");

			expect(loaded).toEqual(snapshot);
		} finally {
			cleanup();
		}
	});

	it("returns null when no snapshot file exists", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });
			expect(await store.load("missing-task")).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("returns null for a corrupt snapshot file", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "task-1.json"), "{not valid json", "utf8");
			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });

			expect(await store.load("task-1")).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("returns null for a snapshot with a mismatched version", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "task-1.json"),
				JSON.stringify({ version: 2, snapshot: "x", cols: 1, rows: 1, savedAt: 1, sessionStartedAt: null }),
				"utf8",
			);
			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });

			expect(await store.load("task-1")).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("leaves the previous snapshot intact when the atomic rename is interrupted", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });
			const original = createSnapshot({ snapshot: "original" });
			await store.save("task-1", original);

			renameControl.failNext = new Error("simulated rename failure");
			const next = createSnapshot({ snapshot: "next" });
			await expect(store.save("task-1", next)).rejects.toThrow("simulated rename failure");

			expect(await store.load("task-1")).toEqual(original);
		} finally {
			cleanup();
		}
	});

	it("skips saving a snapshot larger than the size cap", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });
			const oversized = createSnapshot({ snapshot: "x".repeat(5 * 1024 * 1024) });

			await store.save("task-1", oversized);

			expect(await store.load("task-1")).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("prunes the oldest snapshot files once more than 300 exist", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			await mkdir(dir, { recursive: true });
			const baseTimeSeconds = Math.floor(Date.now() / 1000);
			for (let index = 0; index < 300; index += 1) {
				const filePath = join(dir, `seed-${index}.json`);
				await writeFile(
					filePath,
					JSON.stringify(createSnapshot({ snapshot: `seed-${index}`, savedAt: index })),
					"utf8",
				);
				await utimes(filePath, baseTimeSeconds + index, baseTimeSeconds + index);
			}

			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });
			await store.save("newest-task", createSnapshot({ snapshot: "newest", savedAt: 999 }));

			const remaining = await readdir(dir);
			expect(remaining).toHaveLength(300);
			expect(remaining).not.toContain("seed-0.json");
			expect(remaining).toContain("newest-task.json");
		} finally {
			cleanup();
		}
	}, 15_000);

	it("percent-encodes characters outside [A-Za-z0-9._-] in the snapshot filename", async () => {
		const { path: dir, cleanup } = createTempDir("snapshot-store-");
		try {
			const store = createTerminalSnapshotStore("workspace-1", { baseDir: dir });
			const taskId = "task/weird id:1";

			await store.save(taskId, createSnapshot({ snapshot: "x" }));

			const files = await readdir(dir);
			expect(files).toHaveLength(1);
			expect(files[0]).not.toContain("/");
			expect(files[0]).not.toContain(" ");
			expect(files[0]).not.toContain(":");

			const loaded = await store.load(taskId);
			expect(loaded?.snapshot).toBe("x");
		} finally {
			cleanup();
		}
	});
});
