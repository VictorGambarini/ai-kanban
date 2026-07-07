import { createHash, randomBytes } from "node:crypto";

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
 * A remote machine (VM) that runs its own `ai-kanban` runtime bound to
 * loopback. The hub reaches it by forwarding a local port to the remote
 * runtime port over the SSH connection described by {@link RemoteHostSshConfig}.
 */
export interface RemoteHost {
	id: string;
	label: string;
	/**
	 * How the hub reaches this host:
	 * - `"ssh"` (default) — the hub dials *out* over SSH and bootstraps the runtime.
	 * - `"reverse"` — the host dials *in* to the hub's rendezvous server; the hub never
	 *   dials out. For laptops behind NAT that can reach the hub but not vice-versa.
	 */
	transport: "ssh" | "reverse";
	/** SSH connection details. Present for `"ssh"` transport; absent for `"reverse"`. */
	ssh?: RemoteHostSshConfig;
	/** Port the remote runtime listens on (loopback) and that we forward to. */
	runtimePort: number;
	/** Reverse (dial-in) auth material. Present only for `"reverse"` transport. */
	reverse?: RemoteHostReverseConfig;
	createdAt: number;
}

/** Auth material for a reverse (dial-in) host. The token plaintext is never stored. */
export interface RemoteHostReverseConfig {
	/** SHA-256 hash of the connector's pairing token. */
	tokenHash: string;
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

export const remoteHostReverseConfigSchema = z.object({
	tokenHash: z.string().min(1),
});

export const remoteHostSchema = z.object({
	id: z.string().min(1, "Host ID cannot be empty."),
	label: z.string().min(1, "Host label cannot be empty."),
	// Older records predate the discriminator and were all SSH hosts.
	transport: z.enum(["ssh", "reverse"]).default("ssh"),
	ssh: remoteHostSshConfigSchema.optional(),
	runtimePort: z.number().int().min(1).max(65535).default(DEFAULT_KANBAN_RUNTIME_PORT),
	reverse: remoteHostReverseConfigSchema.optional(),
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

/** Fields a caller supplies when registering a reverse (dial-in) host. */
export interface RegisterReverseHostInput {
	label: string;
}

export const registerReverseHostInputSchema = z.object({
	label: z.string().min(1, "Host label cannot be empty."),
});

/** A host guaranteed to carry SSH config — the hub-dials-out transport. */
export type SshRemoteHost = RemoteHost & { ssh: RemoteHostSshConfig };

export function isReverseHost(host: RemoteHost): boolean {
	return host.transport === "reverse";
}

/** True for hub-dials-out hosts (and narrows the type so `.ssh` is non-optional). */
export function isSshRemoteHost(host: RemoteHost): host is SshRemoteHost {
	return host.transport !== "reverse" && host.ssh !== undefined;
}

/** Generate a pairing token and its stored hash for a reverse host. */
export function createReverseHostToken(): { token: string; tokenHash: string } {
	const token = randomBytes(24).toString("base64url");
	return { token, tokenHash: hashReverseHostToken(token) };
}

export function hashReverseHostToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** A patch for an existing host. `id` and `createdAt` are immutable. */
export interface UpdateRemoteHostInput {
	label?: string;
	ssh?: Partial<RemoteHostSshConfig> & { hostname?: string; username?: string };
	runtimePort?: number;
}

/** Lifecycle state of an SSH connection + its forwarded port. */
export type RemoteHostConnectionState = "disconnected" | "connecting" | "connected" | "error";

export const remoteHostConnectionStateSchema = z.enum(["disconnected", "connecting", "connected", "error"]);

export const remoteHostConnectionStatusSchema = z.object({
	hostId: z.string(),
	state: remoteHostConnectionStateSchema,
	localPort: z.number().int().nullable(),
	error: z.string().nullable(),
	updatedAt: z.number(),
});

/** A host plus its current connection status, as returned to the UI. */
export const remoteHostSummarySchema = z.object({
	host: remoteHostSchema,
	status: remoteHostConnectionStatusSchema.nullable(),
	/**
	 * Why the remote runtime failed to start after SSH connected, if it did. This
	 * is distinct from `status.error` (an SSH-level failure): the tunnel can be up
	 * (`status.state === "connected"`) while the runtime itself never launched —
	 * e.g. the host lacks `npx`. Null when bootstrap succeeded or hasn't run.
	 */
	runtimeError: z.string().nullable(),
	/** Version the remote runtime reports (from its /api/version), or null if unknown. Used to flag hub/remote drift. */
	runtimeVersion: z.string().nullable(),
});
export type RemoteHostSummary = z.infer<typeof remoteHostSummarySchema>;

export const registerRemoteHostInputSchema = z.object({
	label: z.string().min(1, "Host label cannot be empty."),
	ssh: z.object({
		hostname: z.string().min(1, "SSH hostname cannot be empty."),
		port: z.number().int().min(1).max(65535).optional(),
		username: z.string().min(1, "SSH username cannot be empty."),
		privateKeyPath: z.string().min(1).optional(),
		useAgent: z.boolean().optional(),
		passphraseEnv: z.string().min(1).optional(),
	}),
	runtimePort: z.number().int().min(1).max(65535).optional(),
});

export const updateRemoteHostInputSchema = z.object({
	label: z.string().min(1).optional(),
	ssh: z
		.object({
			hostname: z.string().min(1).optional(),
			port: z.number().int().min(1).max(65535).optional(),
			username: z.string().min(1).optional(),
			privateKeyPath: z.string().min(1).optional(),
			useAgent: z.boolean().optional(),
			passphraseEnv: z.string().min(1).optional(),
		})
		.optional(),
	runtimePort: z.number().int().min(1).max(65535).optional(),
});

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
