import type { Command } from "commander";

import { listRemoteHosts, registerRemoteHost, removeRemoteHost } from "../hosts/host-registry";

function printLine(message: string): void {
	process.stdout.write(`${message}\n`);
}

interface AddHostOptions {
	label?: string;
	sshHost: string;
	sshPort?: string;
	user: string;
	identity?: string;
	useAgent?: boolean;
	passphraseEnv?: string;
	runtimePort?: string;
}

function parsePort(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`Invalid ${flag} "${value}". Expected an integer from 1-65535.`);
	}
	return parsed;
}

/**
 * Registers the `hosts` command group for managing remote machines (VMs)
 * that the hub controls over SSH. Commands operate on the persisted registry;
 * a running hub connects registered hosts at startup (or add them live in the UI).
 */
export function registerHostsCommand(program: Command): void {
	const hosts = program
		.command("hosts")
		.description("Manage remote SSH hosts (VMs) the hub controls. The hub connects them at startup.");

	hosts
		.command("add")
		.description("Register a remote host.")
		.requiredOption("--ssh-host <hostname>", "SSH hostname or IP of the remote machine.")
		.requiredOption("--user <username>", "SSH username.")
		.option("--label <text>", "Friendly label. Defaults to the hostname.")
		.option("--ssh-port <number>", "SSH port (default: 22).")
		.option("--identity <path>", "Path to a private key file. Contents are never stored.")
		.option("--use-agent", "Authenticate via the local SSH agent (SSH_AUTH_SOCK).")
		.option("--passphrase-env <name>", "Env var holding the key passphrase. The value is never stored.")
		.option("--runtime-port <number>", "Remote ai-kanban runtime port to tunnel (default: 3484).")
		.action(async (options: AddHostOptions) => {
			const host = await registerRemoteHost({
				label: options.label?.trim() || options.sshHost,
				ssh: {
					hostname: options.sshHost,
					port: parsePort(options.sshPort, "--ssh-port"),
					username: options.user,
					privateKeyPath: options.identity,
					useAgent: options.useAgent === true,
					passphraseEnv: options.passphraseEnv,
				},
				runtimePort: parsePort(options.runtimePort, "--runtime-port"),
			});
			printLine(
				`Registered host "${host.label}" (id: ${host.id}) — ${host.ssh.username}@${host.ssh.hostname}:${host.ssh.port}`,
			);
			printLine("Restart the hub (or use the UI) to connect it.");
		});

	hosts
		.command("list")
		.description("List registered remote hosts.")
		.action(async () => {
			const all = await listRemoteHosts();
			if (all.length === 0) {
				printLine("No remote hosts registered. Add one with: ai-kanban hosts add --host <ip> --user <name>");
				return;
			}
			for (const host of all) {
				printLine(
					`${host.id}\t${host.label}\t${host.ssh.username}@${host.ssh.hostname}:${host.ssh.port}\truntime:${host.runtimePort}`,
				);
			}
		});

	hosts
		.command("rm")
		.alias("remove")
		.description("Remove a registered remote host.")
		.argument("<hostId>", "Host id (see `hosts list`).")
		.action(async (hostId: string) => {
			const removed = await removeRemoteHost(hostId);
			if (removed) {
				printLine(`Removed host "${hostId}".`);
			} else {
				printLine(`No host found with id "${hostId}".`);
				process.exitCode = 1;
			}
		});
}
