## npx kanban (Research Preview)

<p align="center">
  <img src="https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe" width="100%" />
</p>

A replacement for your IDE better suited for running many agents in parallel and reviewing diffs. Each task card gets its own terminal and worktree, all handled for you automatically. Enable auto-commit and link cards together to create dependency chains that complete large amounts of work autonomously.

> [!NOTE]
> **This is a community fork** of [cline/kanban](https://github.com/cline/kanban), maintained by [@VictorGambarini](https://github.com/VictorGambarini). It tracks upstream and adds functionality for running Kanban as a **remote / self-hosted server** you reach from a browser — for example on a VM behind Tailscale. See [Remote / self-hosted access](#remote--self-hosted-access-fork-additions) for what's new. Upstream credit and license remain with Cline Bot Inc.

> [!WARNING]
> Kanban is a research preview and uses experimental features of CLI agents like bypassing permissions and runtime hooks for more autonomy. We'd love your feedback in #kanban on our [discord](https://discord.gg/cline).

<div align="left">
<table>
<tbody>
<td align="center">
<a href="https://www.npmjs.com/package/kanban" target="_blank">NPM</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban" target="_blank">GitHub</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/issues" target="_blank">Issues</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop" target="_blank">Feature Requests</a>
</td>
<td align="center">
<a href="https://discord.gg/cline" target="_blank">Discord</a>
</td>
<td align="center">
<a href="https://x.com/cline" target="_blank">@cline</a>
</td>
</tbody>
</table>
</div>

### 1. Open kanban
```bash
# Run directly (no install required)
npx kanban

# Or install globally
npm i -g kanban
kanban
```
Run this from the root of any git repo. Kanban will detect your installed CLI agent and launch a local running webserver in your browser. No account or setup required, it works right out of the box.

### 2. Create tasks
Create a task card manually, or open the sidebar chat and ask your agent to break work down into tasks for you. Kanban injects board-management instructions into that session so you can simply ask it to add tasks, link tasks, or start work on your board.

### 3. Link and automate
<kbd>⌘</kbd> + click a card to link it to another task. When a card is completed and moved to trash, linked tasks auto-start. Combine with auto-commit for fully autonomous dependency chains: one task completes → commits → kicks off the next → repeat. It’s a pretty magical experience asking your agent to decompose a big task into subtasks that auto-commit - he’ll cleverly do it in a way that parallelizes for maximum efficiency and links tasks together for end-to-end autonomy.

### 4. Start tasks
Hit the play button on a card. Kanban creates an ephemeral worktree just for that task so agents work in parallel without merge conflicts. Under the hood, it also symlinks gitignored files like `node_modules` so you don't have to worry about slow `npm install`s for each copy of your project.

> [!NOTE]
> [Symlinks (symbolic links)](https://en.wikipedia.org/wiki/Symbolic_link) are special "shortcuts" pointing to another file or directory, allowing access to the target from a new location without duplicating data. They work great in this case since you typically don't modify gitignored files in day-to-day work, but for when you do then don't use Kanban.

As agents work, Kanban uses hooks to display the latest message or tool call on each card, so you can monitor hundreds of agents at a glance without opening each one.

### 5. Review changes
Click a card to view the agent's TUI and a diff of all the changes in that worktree. Kanban includes its own checkpointing system so you can also see a diff from the last messages you've sent. Click on lines to leave comments and send them back to the agent.

To easily test and debug your app, create a Script Shortcut in settings. Use a command like `npm run dev` so that all you have to do is hit a play button in the navbar instead of remembering commands or asking your agent to do it.

### 6. Ship it
When the work looks good, hit **Commit** or **Open PR**. Kanban sends a dynamic prompt to the agent to convert the worktree into a commit on your base ref or a new PR branch, and work through any merge conflicts intelligently. Or skip review by enabling auto-commit / auto-PR and the agent ships as soon as it's done. Move the card to trash to clean up the worktree (you can always resume later since Kanban tracks the resume ID).

### 7. Keep track with git interface
Click the branch name in the navbar to open a full git interface to browse commit history, switch branches, fetch, pull, push, and visualize your git all without leaving Kanban. Keep track of everything your agents are doing across branches as work is completed.

---

## Remote / self-hosted access (fork additions)

Upstream Kanban is built to run locally and open a browser on the same machine. This fork makes it practical to run Kanban on a **remote box** (a VM, a home server, a Tailscale node) and use it from any browser, while keeping it locked down.

Bind to a non-loopback host to enable **remote mode**. In remote mode Kanban auto-generates a passcode and guards every request behind it plus a Host/Origin allowlist (DNS-rebinding protection).

```bash
# Auto-generated passcode (printed once at startup)
kanban --host 0.0.0.0

# Pin a fixed passcode so it survives restarts (PM2 / systemd / Docker)
kanban --host 0.0.0.0 --passcode "$KANBAN_PASSCODE"

# Disable the passcode entirely (only if another layer handles auth,
# e.g. a reverse proxy or a private Tailscale network)
kanban --host 100.x.y.z --port 80 --no-passcode
```

New flags:

| Flag | Description |
| --- | --- |
| `--passcode <value>` | Pin the remote access passcode to a fixed value instead of a fresh random one each start. Stable across restarts; not echoed to logs. |
| `--no-passcode` | Disable passcode auth (for use behind your own auth layer). *Now actually works* — the upstream flag was parsed but never applied. |
| `--allowed-host <host>` | Add an extra Host/Origin name the server will accept in remote mode (repeatable). Needed to reach the server by a DNS / reverse-proxy / Tailscale MagicDNS name rather than only its bound IP. Also settable via `KANBAN_ALLOWED_HOSTS` (comma-separated). |

The Host/Origin gates also now accept the bare host on the scheme default ports (80/443), so a normal `http://your-host/` URL works without the port suffix.

**Example: Tailscale-only on port 80 via systemd.** Reachable from your devices as `http://kanban/ai-kanban` over the tailnet, never exposed to the public internet:

```ini
# /etc/systemd/system/kanban.service
[Service]
ExecStart=/usr/bin/node /path/to/kanban/dist/cli.js \
  --host 100.x.y.z --port 80 --no-passcode --no-open --allowed-host kanban
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
```

> [!WARNING]
> Kanban runs coding agents that execute arbitrary code. Do not expose it to the public internet behind only a passcode. Prefer a private network (Tailscale/WireGuard/VPN), an SSH tunnel, or an authenticating reverse proxy.

---

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
