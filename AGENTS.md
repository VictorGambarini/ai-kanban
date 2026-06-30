This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions. For things like Cline SDK reasoning settings, use the SDK's source of truth whenever possible instead of recreating unions, support checks, or shapes in Kanban.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Kanban web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Misc. tribal knowledge
- Kanban's native Cline agent is powered by the installed `@clinebot/core` and `@clinebot/llms` packages plus the local `src/cline-sdk/` boundary layer, so when Cline behavior is unclear, inspect those packages and `src/cline-sdk/` for the real implementation details.
- Kanban is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- If CI hangs on Node 22 after tests seem to finish, suspect a live subprocess or SDK-host startup path before assuming a slow test body. Read `.plan/docs/node22-ci-hanging-tests-investigation.md` before repeating that investigation. `test/runtime/cline-sdk/cline-task-session-service.test.ts` was the big prior culprit because a unit-style suite was still booting the real Cline SDK host.
- When Kanban runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- Remote access has TWO gates beyond the passcode, both in `src/server/middleware.ts`, and both will hand back a bare `403` that is easy to misread as an auth failure. (1) Host header allowlist (`getAllowedHostHeaders`) and (2) CORS Origin allowlist (`getAllowedOrigins`). In remote mode they only accept the bound host. Two gotchas: browsers OMIT the port on the scheme default ports (80/http, 443/https), so the allowlist must accept the bare host too; and reaching the server by a DNS / reverse-proxy / Tailscale MagicDNS name fails until that name is added via `--allowed-host <host>` (repeatable; env `KANBAN_ALLOWED_HOSTS`, stored in `runtime-endpoint.ts`). If a remote browser gets 403 but the passcode is fine, check these gates first. Note `--no-passcode` only disables the passcode; the Host/Origin gates still apply.
- Multi-host control ("vans") lives in `src/hosts/`: a file-backed registry (`~/.cline/kanban/hosts.json`), an `ssh2`-based connection manager that forwards a hub loopback port to each van's runtime, a detached remote-runtime bootstrap, an HTTP/WS reverse proxy, and a board-aggregation layer that host-namespaces task ids as `hostId::taskId`. `HostsManager` ties them together; it's constructed inside `createRuntimeServer` (not via CLI deps) and exposed to the UI through the `hosts.*` tRPC router. Two non-obvious things: (1) the hub selects a target host via the `x-kanban-host-id` header / `hostId` query, mirroring the existing `x-kanban-workspace-id` pattern, with `"local"` meaning the hub itself; (2) the WS proxy MUST be registered before the runtime/terminal upgrade listeners and set `request.__kanbanUpgradeHandled = true`, and those downstream listeners now bail on that flag — otherwise a proxied terminal upgrade gets double-handled. The remote runtime is launched loopback-bound with `--no-passcode` on purpose: the SSH tunnel is the trust boundary, so no Host/Origin gating applies to the forwarded port.
- Per-task skill selection is additive and only partially restrictive — agents auto-discover their own skill directories, so "only these skills" is achieved by hiding the rest where the agent supports it. Read `docs/skills.md` before touching skill install/injection/isolation. Hard limits (empirically verified, not bugs): Claude Code's `skillOverrides` does NOT hide marketplace plugin skills (`<plugin>:<skill>`) in any key form, and Cline exposes no per-run knob to hide globally-installed skills. The Claude isolation file is the worktree's `.claude/settings.local.json` (`skillOverrides` + `disableBundledSkills`), which coexists with the `--settings` hooks file Kanban passes (one does not override the other). Injected/installed skill files are kept out of task diffs via `ensureSkillGitExcludes` writing the shared `.git/info/exclude` (untracked-only).
- The remote runtime is launched over an SSH `exec` channel, which is a NON-interactive, non-login shell with a stripped PATH — it does NOT include login-only entries like `~/.local/bin` (where `claude` installs) or nvm. Agent discovery happens at runtime startup, so an agent installed on the VM after launch is invisible until the runtime restarts AND is launched with the right PATH. Fix lives in `remote-runtime-bootstrap.ts`: both the `command -v` probe and the detached launch run through `bash -lc` (`loginShellCommand`) so they inherit the user's full login PATH. The restart path (`HostsManager.restartHost` → `stopRemoteRuntime`, exposed as `hosts.restart` + the ↻ button in the host switcher) kills the runtime by port (`fuser -k <port>/tcp`) plus the `[a]i-kanban` bracket-trick `pkill`, then re-bootstraps. If a remote agent isn't detected, suspect login-PATH first, then whether the runtime was bounced.
- Task/session state survival across a runtime restart hinges on TWO cooperating layers, and getting either wrong looks like "tasks jumped to Done / sessions vanished" data loss. (1) `src/server/shutdown-coordinator.ts` runs on every normal Ctrl+C/restart (unless `--skip-shutdown-cleanup`): it must ONLY mark still-running sessions `interrupted` and must NEVER move cards between columns or delete worktrees — the SDK persists conversation history globally (`resolveClineDataDir()`), so an in-place worktree + an `interrupted` summary is all that's needed to resume. (Genuine board mutation/worktree deletion belongs only on explicit project removal via `collectProjectWorktreeTaskIdsForRemoval` in `workspace-registry.ts`/`projects-api.ts`.) (2) The session→board reconcile effect in `web-ui/src/hooks/use-board-interactions.ts` auto-moves a task to trash when its session becomes `interrupted` — guard it so it only fires on a genuine LIVE transition (`previous && previous.state !== "interrupted"`, never on initial hydration) and only for active columns (`in_progress`/`review`, never `backlog`), or restored/back-to-backlog cards get trashed. Resuming a restarted task also requires `sendTaskSessionInput` (in `cline-sdk/cline-task-session-service.ts`) to `rebindPersistedTaskSession` first when the in-memory entry is gone, like `stopTaskSession`/`reloadTaskSession` already do.
- `npm run dev` (and any `tsx`/packaged run) serves the web-ui from the BUILT bundle, not live source. `getWebUiDir()` in `src/server/assets.ts` resolves to `web-ui/dist` (repo build) when running via tsx; there is no Vite middleware in the runtime server. So after changing anything under `web-ui/src`, run `npm run web:build` before reloading the browser, or you will test a stale bundle and new components silently appear missing (they render fine but aren't in the served JS). For a live-reload loop on the UI alone, run `npm run web:dev` (Vite on its own port) instead.
- Custom agent env vars (for `gh`, Jira keys, `ANTHROPIC_*` overrides, etc.) are hub-central and resolved at TASK-START, not runtime boot. The full config (`{ global, projects[projectId], tasks[taskId] }`) lives ONLY in the hub's global config (`~/.cline/kanban/config.json`, chmod 600) via `loadAgentEnvConfig`/`saveAgentEnvConfig` in `src/config/runtime-config.ts`; the web-ui reads/writes it through the `getHubTrpcClient()` (never the active-host client) so it stays hub-sourced even when a remote board is selected. At launch the web-ui resolves the three scopes (`resolveEffectiveAgentEnv` in `src/core/agent-env.ts`, task > project > global) and ships the merged map in the `startTaskSession` request `env` field. Because the host proxy just pipes the request body, the spawning runtime (local OR proxied remote) applies the same set verbatim via `buildTerminalEnvironment` — there is intentionally no per-runtime env config. Two gotchas: (1) this only reaches PTY/CLI agents (Claude Code, Codex, …); the Cline agent runs in-process so its shell commands inherit only the runtime's `process.env`, NOT per-task env. (2) Project/task env are keyed by the web-ui's workspace/task id; the same id must be used at launch (`use-task-sessions.ts`) and in the settings/card editors, or a scope silently won't match.
- The web-ui board is re-hydrated from persisted workspace state through `normalizeCard()` in `web-ui/src/state/board-state.ts` (via `normalizeBoardData`), which rebuilds each `BoardCard` field-by-field. It does NOT spread the raw card. So any new persisted card field (e.g. `skillNames`) MUST be added in BOTH places there — the `card as { ... }` destructure type AND the returned object — or it round-trips through `board.json` and the Zod contract schema fine but is silently stripped on every reload. Symptom: a value you just saved is present on disk yet gone from the UI after refresh. This bit the per-task `skillNames` selection (badge/popover showed none even though the worktree had the skills injected).
- Custom / OpenAI-compatible providers (Ollama, MLX, LiteLLM, any user-added base URL) live in `~/.cline`'s `models.json` + provider settings on disk, but the `@clinebot/core` SDK only auto-registers them into its in-memory llms registry inside the **hub daemon** (`dist/hub/daemon/entry.js`) — the local in-process backend used by Kanban tasks does NOT. `@clinebot/core`'s `addLocalProvider` registers the provider in the current process only, so a provider added in one runtime works until the next restart, then `createHandler`/model resolution throws "Provider … is not known" — this was the upstream "can't use OpenAI-compatible providers" cluster (cline/kanban#484/#474/#111/#301/#164). Fix: `ensureSdkCustomProvidersLoaded()` in `sdk-provider-boundary.ts` re-registers them from disk; `cline-provider-service.ts` calls it eagerly at construction AND lazily (memoized) before each `resolveLaunchConfig`/`getProviderCatalog`/`getProviderModels`. If a custom provider "disappears" after a restart, suspect this registration step, not the save pipeline (which is fine). Separately, a custom provider's saved `timeout`/`headers` reach request time through the llms-registry **defaults** set at registration, not through the per-session launch config (which only carries providerId/modelId/apiKey/baseUrl/reasoningEffort) — so re-registration is also what makes those honored on every run. The LiteLLM model-list fetch in `cline-provider-service.ts` honors the configured `settings.timeout` verbatim (no upper cap); the `2_500`ms constant is only a fallback when unset (it used to be a `Math.min` cap that starved slow local endpoints — cline/kanban#181).
