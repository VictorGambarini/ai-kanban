import { z } from "zod";

import { DEFAULT_KANBAN_RUNTIME_PORT } from "../core/runtime-endpoint";

/**
 * Connection details for reaching a remote host over SSH. Secret material is
 * never persisted: we store a reference to a private key *path* and/or opt into
 * the local SSH agent, and read any key passphrase from a named environment
 * variable rather than writing it to disk.
 */
export interface RemoteHostSshConfig {
	hostname: string;
	port: number;
	username: string;
	/** Absolute path to a private key file. Contents are read at connect time, never stored. */
	privateKeyPath?: string;
	/** Use the local SSH agent (SSH_AUTH_SOCK) for authentication. */
	useAgent?: boolean;
	/** Name of an environment variable holding the private key passphrase. The value is never persisted. */
	passphraseEnv?: string;
}

/**
 * A remote machine ("van") that runs its own `ai-kanban` runtime bound to
 * loopback. The hub reaches it by forwarding a local port to the remote
 * runtime port over the SSH connection described by {@link RemoteHostSshConfig}.
 */
export interface RemoteHost {
	id: string;
	label: string;
	ssh: RemoteHostSshConfig;
	/** Port the remote `ai-kanban` runtime listens on (loopback) and that we forward to. */
	runtimePort: number;
	createdAt: number;
}

const DEFAULT_SSH_PORT = 22;

export const remoteHostSshConfigSchema = z.object({
	hostname: z.string().min(1, "SSH hostname cannot be empty."),
	port: z.number().int().min(1).max(65535).default(DEFAULT_SSH_PORT),
	username: z.string().min(1, "SSH username cannot be empty."),
	privateKeyPath: z.string().min(1).optional(),
	useAgent: z.boolean().optional(),
	passphraseEnv: z.string().min(1).optional(),
});

export const remoteHostSchema = z.object({
	id: z.string().min(1, "Host ID cannot be empty."),
	label: z.string().min(1, "Host label cannot be empty."),
	ssh: remoteHostSshConfigSchema,
	runtimePort: z.number().int().min(1).max(65535).default(DEFAULT_KANBAN_RUNTIME_PORT),
	createdAt: z.number(),
});

export const HOSTS_FILE_VERSION = 1;

export interface RemoteHostsFile {
	version: number;
	hosts: Record<string, RemoteHost>;
}

export const remoteHostsFileSchema = z
	.object({
		version: z.literal(HOSTS_FILE_VERSION),
		hosts: z.record(z.string(), remoteHostSchema),
	})
	.superRefine((file, context) => {
		for (const [hostId, host] of Object.entries(file.hosts)) {
			if (host.id !== hostId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["hosts", hostId, "id"],
					message: `Host ID must match record key "${hostId}".`,
				});
			}
		}
	});

/** Fields a caller supplies when registering a host; the registry fills in `id` and `createdAt`. */
export interface RegisterRemoteHostInput {
	label: string;
	ssh: {
		hostname: string;
		port?: number;
		username: string;
		privateKeyPath?: string;
		useAgent?: boolean;
		passphraseEnv?: string;
	};
	runtimePort?: number;
}

/** A patch for an existing host. `id` and `createdAt` are immutable. */
export interface UpdateRemoteHostInput {
	label?: string;
	ssh?: Partial<RemoteHostSshConfig> & { hostname?: string; username?: string };
	runtimePort?: number;
}

/** Lifecycle state of an SSH connection + its forwarded port. */
export type RemoteHostConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface RemoteHostConnectionStatus {
	hostId: string;
	state: RemoteHostConnectionState;
	/** Loopback port on the hub that tunnels to the remote runtime, when connected. */
	localPort: number | null;
	/** Most recent error message, when `state` is `"error"`. */
	error: string | null;
	updatedAt: number;
}

/** Result of running a single command on a remote host over SSH. */
export interface RemoteCommandResult {
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
}
