import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";

import { DEFAULT_KANBAN_RUNTIME_PORT } from "../core/runtime-endpoint";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import {
	HOSTS_FILE_VERSION,
	type RegisterRemoteHostInput,
	type RemoteHost,
	type RemoteHostsFile,
	remoteHostsFileSchema,
	type UpdateRemoteHostInput,
} from "./host-types";

const HOSTS_FILENAME = "hosts.json";
const DEFAULT_SSH_PORT = 22;
const HOST_ID_RANDOM_LENGTH = 6;

function getHostsFilePath(): string {
	return join(getRuntimeHomePath(), HOSTS_FILENAME);
}

function getHostsFileLockRequest(): LockRequest {
	return {
		path: getHostsFilePath(),
		type: "file",
	};
}

function createEmptyHostsFile(): RemoteHostsFile {
	return {
		version: HOSTS_FILE_VERSION,
		hosts: {},
	};
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length === 0 ? "root" : issue.path.join(".")}: ${issue.message}`)
		.join("; ");
}

async function readHostsFile(): Promise<RemoteHostsFile> {
	const path = getHostsFilePath();
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return createEmptyHostsFile();
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read hosts file at ${path}. ${message}`);
	}
	const parsed = remoteHostsFileSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid hosts file at ${path}. Fix or remove the file. Validation errors: ${formatSchemaIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

async function writeHostsFile(file: RemoteHostsFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getHostsFilePath(), file, { lock: null });
}

function toHostIdBase(label: string): string {
	const normalized = label
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "host";
}

function createHostId(file: RemoteHostsFile, label: string): string {
	const base = toHostIdBase(label);
	if (!file.hosts[base]) {
		return base;
	}
	for (let attempt = 0; attempt < 256; attempt += 1) {
		const candidate = `${base}-${randomBytes(HOST_ID_RANDOM_LENGTH).toString("hex").slice(0, HOST_ID_RANDOM_LENGTH)}`;
		if (!file.hosts[candidate]) {
			return candidate;
		}
	}
	throw new Error(`Could not generate a unique host ID for "${label}".`);
}

function buildHost(file: RemoteHostsFile, input: RegisterRemoteHostInput): RemoteHost {
	return {
		id: createHostId(file, input.label),
		label: input.label,
		ssh: {
			hostname: input.ssh.hostname,
			port: input.ssh.port ?? DEFAULT_SSH_PORT,
			username: input.ssh.username,
			privateKeyPath: input.ssh.privateKeyPath,
			useAgent: input.ssh.useAgent,
			passphraseEnv: input.ssh.passphraseEnv,
		},
		runtimePort: input.runtimePort ?? DEFAULT_KANBAN_RUNTIME_PORT,
		createdAt: Date.now(),
	};
}

export async function listRemoteHosts(): Promise<RemoteHost[]> {
	const file = await readHostsFile();
	return Object.values(file.hosts).sort((left, right) => left.label.localeCompare(right.label));
}

export async function getRemoteHost(hostId: string): Promise<RemoteHost | null> {
	const file = await readHostsFile();
	return file.hosts[hostId] ?? null;
}

export async function registerRemoteHost(input: RegisterRemoteHostInput): Promise<RemoteHost> {
	return await lockedFileSystem.withLock(getHostsFileLockRequest(), async () => {
		const file = await readHostsFile();
		const host = buildHost(file, input);
		file.hosts[host.id] = host;
		await writeHostsFile(file);
		return host;
	});
}

export async function updateRemoteHost(hostId: string, patch: UpdateRemoteHostInput): Promise<RemoteHost | null> {
	return await lockedFileSystem.withLock(getHostsFileLockRequest(), async () => {
		const file = await readHostsFile();
		const existing = file.hosts[hostId];
		if (!existing) {
			return null;
		}
		const next: RemoteHost = {
			...existing,
			label: patch.label ?? existing.label,
			runtimePort: patch.runtimePort ?? existing.runtimePort,
			ssh: {
				...existing.ssh,
				...patch.ssh,
			},
		};
		file.hosts[hostId] = next;
		await writeHostsFile(file);
		return next;
	});
}

export async function removeRemoteHost(hostId: string): Promise<boolean> {
	return await lockedFileSystem.withLock(getHostsFileLockRequest(), async () => {
		const file = await readHostsFile();
		if (!file.hosts[hostId]) {
			return false;
		}
		delete file.hosts[hostId];
		await writeHostsFile(file);
		return true;
	});
}
