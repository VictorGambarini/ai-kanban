// Best-effort, on-disk persistence for a task's final terminal scrollback, so
// Done/trash cards can still show PTY history after a runtime restart. See
// src/terminal/terminal-state-mirror.ts for the in-memory mirror this backs up.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getWorkspaceDirectoryPath } from "../state/workspace-state";

const SNAPSHOT_STORE_DIRNAME = "terminal-snapshots";
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 300;
const SNAPSHOT_VERSION = 1 as const;

export interface PersistedTerminalSnapshot {
	version: 1;
	snapshot: string;
	cols: number;
	rows: number;
	savedAt: number;
	sessionStartedAt: number | null;
}

export interface TerminalSnapshotStore {
	load(taskId: string): Promise<PersistedTerminalSnapshot | null>;
	save(taskId: string, snapshot: PersistedTerminalSnapshot): Promise<void>;
	remove(taskId: string): Promise<void>;
}

function encodeTaskIdForFilename(taskId: string): string {
	return Array.from(taskId)
		.map((char) => (/[A-Za-z0-9._-]/.test(char) ? char : `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`))
		.join("");
}

function isPersistedTerminalSnapshot(value: unknown): value is PersistedTerminalSnapshot {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === SNAPSHOT_VERSION &&
		typeof candidate.snapshot === "string" &&
		typeof candidate.cols === "number" &&
		typeof candidate.rows === "number" &&
		typeof candidate.savedAt === "number" &&
		(candidate.sessionStartedAt === null || typeof candidate.sessionStartedAt === "number")
	);
}

async function pruneOldestSnapshots(dirPath: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dirPath);
	} catch {
		return;
	}
	if (entries.length <= MAX_SNAPSHOT_FILES) {
		return;
	}
	const withStats = await Promise.all(
		entries.map(async (name) => {
			try {
				const info = await stat(join(dirPath, name));
				return { name, mtimeMs: info.mtimeMs };
			} catch {
				return null;
			}
		}),
	);
	const files = withStats.filter((entry): entry is { name: string; mtimeMs: number } => entry !== null);
	files.sort((left, right) => left.mtimeMs - right.mtimeMs);
	const excess = files.length - MAX_SNAPSHOT_FILES;
	if (excess <= 0) {
		return;
	}
	await Promise.all(
		files.slice(0, excess).map(async (file) => {
			try {
				await unlink(join(dirPath, file.name));
			} catch {
				// Best-effort prune; a leftover file just delays the next prune pass.
			}
		}),
	);
}

export function createTerminalSnapshotStore(
	workspaceId: string,
	options: { baseDir?: string } = {},
): TerminalSnapshotStore {
	const dirPath = options.baseDir ?? join(getWorkspaceDirectoryPath(workspaceId), SNAPSHOT_STORE_DIRNAME);

	function filePathFor(taskId: string): string {
		return join(dirPath, `${encodeTaskIdForFilename(taskId)}.json`);
	}

	return {
		async load(taskId) {
			try {
				const raw = await readFile(filePathFor(taskId), "utf8");
				const parsed: unknown = JSON.parse(raw);
				return isPersistedTerminalSnapshot(parsed) ? parsed : null;
			} catch {
				return null;
			}
		},

		async save(taskId, snapshot) {
			const serialized = JSON.stringify(snapshot);
			if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
				// Silently skip: mirror scrollback is capped at 10k lines so this should
				// never trigger in practice, and persistence is best-effort regardless.
				return;
			}
			await mkdir(dirPath, { recursive: true });
			const filePath = filePathFor(taskId);
			const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
			await writeFile(tempPath, serialized, "utf8");
			await rename(tempPath, filePath);
			await pruneOldestSnapshots(dirPath);
		},

		async remove(taskId) {
			try {
				await unlink(filePathFor(taskId));
			} catch {
				// Missing file is fine; removal is idempotent.
			}
		},
	};
}
