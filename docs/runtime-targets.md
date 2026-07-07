# Per-task runtime targets

Each task card can choose **where it executes** via its `runtimeTarget`:

| Target | Meaning | Where the worktree + agent live |
| --- | --- | --- |
| `local` (default) | The hub — the machine running the `ai-kanban` you're looking at | Hub filesystem |
| `ssh:<hostId>` | A registered remote host, reached over the SSH tunnel | Remote host filesystem |
| `docker:<profileId>` | A per-task Docker sandbox (Sysbox) | Hub filesystem, bind-mounted into the sandbox |

The **board is always hub-owned**: cards, columns, and project state come from the hub.
Only a task's *execution* (worktree creation, agent process, terminal, chat, and its live
session state) is dispatched to the chosen target. Remote tasks route through the existing
`x-kanban-host-id` proxy; their live session summaries are fanned in from each remote host's
state stream (see `web-ui/src/runtime/use-remote-session-streams.ts`).

Pick a target in **Override Agent Settings → Runtime** when creating a card, or on the card
detail view. Cline (the in-process agent) cannot run inside a Docker sandbox — it has no exec
boundary — so Docker targets are disabled for it. Cline *can* run on an SSH host (the remote
runs a full `ai-kanban`).

## Always-on hub on a VM (reach it from anywhere, incl. your phone)

Because the board is hub-owned, the natural deployment is to run the hub itself on an
always-on VM and reach it remotely. Your laptop then becomes just another execution target.

1. **Run the hub on the VM** (bind to the address you'll reach, set a passcode, and allow the
   hostname you'll use — see `src/server/middleware.ts` for the Host/Origin gates):

   ```bash
   ai-kanban --host 0.0.0.0 --port 3000 --allowed-host kanban.example.com
   ```

   Reach it at `https://kanban.example.com` (behind your TLS proxy / Tailscale). The passcode
   plus the Host/Origin allowlist are the trust boundary. From your phone, just open that URL.

2. **Register your laptop (or any VM) as an SSH host** via the **Hosts** control in the sidebar
   (add its SSH hostname/user/key). The hub tunnels to a loopback-bound `ai-kanban` it launches
   on that host.

3. **Target tasks per card**: leave a task on `local` to run on the VM, or set it to
   `ssh:<laptop>` to run on your laptop — all from the one board you reach from your phone.

## Docker sandbox targets (`docker:<profileId>`)

A Docker target runs each task in its **own per-task Sysbox container** — an unprivileged
nested Docker engine. The task's `docker compose` stack is brought up **unmodified** inside
that engine, so published ports bind inside the task's own engine and **parallel tasks never
collide on host ports** — `localhost:3000` behaves exactly like it would on a laptop.

- The worktree is created on the hub (as usual) and **bind-mounted** into the sandbox at
  `/workspace`; the agent runs inside via `docker exec`.
- On task stop / cleanup the sandbox container is removed (`docker rm -f`), taking its inner
  engine and the compose stack with it.
- **Cline is not supported** in Docker sandboxes (it runs in-process, with no exec boundary).

### Prerequisites

- **Sysbox** installed on the hub (`sysbox-runc` registered with the Docker daemon). This is what
  makes unprivileged nested Docker safe. Without it, either install Sysbox or set a profile's
  `runtime` to `runc` to accept privileged Docker-in-Docker.
- A sandbox **image** that includes the Docker CLI + daemon and the agent CLI(s) you'll run.

### Defining a profile

Profiles are hub-central config, stored in `~/.cline/kanban/config.json` under
`dockerSandboxProfiles`. Each profile:

```jsonc
{
  "dockerSandboxProfiles": [
    {
      "id": "web",
      "label": "Web stack",
      "image": "kanban/sandbox:latest",   // must have docker + your agent CLI
      "composeFile": "docker-compose.yml", // relative to the repo root; omit to skip `up`
      "runtime": "sysbox-runc"             // default; use "runc" only for privileged DinD
    }
  ]
}
```

Once a profile exists it appears in **Override Agent Settings → Runtime** as
`docker:<id>`. (A dedicated settings editor for these profiles is a follow-up; edit the config
file for now.)

> **Caveat:** each nested engine has its **own image cache**, so first builds are cold. Configure
> a shared registry mirror / cache in your sandbox image if cold builds are painful.

### Requirements for an SSH target

The remote host must have the project's **repository present** (same workspace) so the worktree
can be created there; if it isn't, starting the task surfaces an actionable error naming the
host. Auto-provisioning (clone-on-demand) is planned. The remote also needs the task's agent CLI
installed on its login `PATH` (agents are detected at runtime startup — restart the host after
installing one; see the `↻` action in the Hosts control).

## Dial-in hosts (reverse tunnel) — for machines behind NAT

The SSH-host path is **hub-initiated**: the hub dials *out* to the host, so it needs to be able
to reach it. That fails when the runtime is on a **laptop behind NAT** that can reach the hub but
not vice-versa. A **dial-in host** inverts the direction — the laptop connects *to* the hub and
registers itself.

**Enable the rendezvous server on the hub** (an in-process SSH server that dial-in connectors
attach to). It is **off by default** and binds **loopback by default** — expose it only over a
private network (Tailscale/WireGuard), never publicly:

```bash
# On the VM/hub. Bind the rendezvous to the tailnet interface, not 0.0.0.0.
ai-kanban --host 0.0.0.0 --port 3000 --allowed-host kanban.example.com \
  --rendezvous-port 3485 --rendezvous-bind <vm-tailscale-ip>
```

(Env equivalents: `KANBAN_RENDEZVOUS_PORT`, `KANBAN_RENDEZVOUS_BIND`.)

**Create the host in the UI:** Hosts → *Add dial-in host*. You get a one-time **pairing token**,
the exact `ai-kanban connect …` command, and the rendezvous **host-key fingerprint** to pin.

**Run the connector on the laptop:**

```bash
ai-kanban connect --hub kanban.example.com:3485 \
  --host-id <id> --token <token> --fingerprint SHA256:<...>
```

This starts a loopback runtime on the laptop and reverse-forwards it to the hub. The host then
shows **connected**, and you target tasks at it (`ssh:<id>`) like any other host — task-start,
terminal, and live state flow hub→laptop over the connection the laptop dialed. The connector
keeps the tunnel alive and auto-reconnects; the runtime is `--no-passcode` on laptop loopback only
(never published) — the tunnel + token are the trust boundary.

> If both machines are already on a Tailscale tailnet, you don't need dial-in at all — the hub can
> reach the laptop directly, so a normal SSH host works. Dial-in is for when only the laptop→hub
> direction is available.
