# Skills

How Kanban manages [Agent Skills](https://agentskills.io): installing them, storing
metadata, presenting them in the UI, injecting the selected ones into a task's worktree,
and isolating which skills each agent can see for a run.

For the underlying skill format and the agents' own behavior, see the reference material
in [`../.plan/docs/Skills/`](../.plan/docs/Skills/) (`agent-skills-protocol.md`,
`claude-code-skills.md`).

## Mental model

A *skill* is a directory containing `SKILL.md` (YAML frontmatter + markdown). Kanban does
not reimplement skill storage — it shells out to the `npx skills` CLI for install/list,
reads/writes `SKILL.md` frontmatter directly for metadata, and copies skill directories
into task worktrees.

Two facts drive most of the design:

1. **Skills are installed at project scope.** `installSkill` runs `npx skills add … -p`,
   which writes the skill files into the workspace's `.agents/skills/` and
   `.claude/skills/`. They are real files in the user's project.
2. **Agents auto-discover skills from several locations** that Kanban does not own
   (`~/.claude/skills`, `~/.agents/skills`, plugins for Claude Code; `~/.cline/skills`,
   `.agents/skills`, `.claude/skills` for Cline). Per-task selection therefore can only
   *add* skills by copying them in, and *hide* others where an agent exposes a knob.
## Data model

`RuntimeWorkspaceSkill` (`src/core/api-contract.ts`) is the canonical shape:

| Field          | Source                                                          |
| -------------- | -------------------------------------------------------------- |
| `name`         | `SKILL.md` frontmatter `name` (sanitized)                      |
| `description`  | `SKILL.md` frontmatter                                          |
| `disabled`     | sidecar (`.agents/skills-meta.json`), legacy frontmatter as fallback |
| `dirPath`      | absolute path on disk                                           |
| `scope`        | `"project"` (workspace dirs) or `"global"` (home dirs)        |
| `installedFrom`| sidecar → `skills-lock.json` → legacy frontmatter              |
| `installedAt`  | sidecar → legacy frontmatter                                    |

`installedFrom` powers source grouping; `installedAt` powers the "NEW" badge (48h window).

### The metadata sidecar

Kanban-owned skill metadata lives in **`.agents/skills-meta.json`** (git-excluded like the
skill files), with separate `project` and `global` maps keyed by skill name. Kanban never
writes into `SKILL.md`: frontmatter stamping invalidated the `skills` CLI's `computedHash`
integrity record and only landed on one of the two installed copies. Legacy frontmatter
fields (`installedFrom`/`installedAt`/`disabled`) are still read as fallbacks, and the
first listing backfills lock/frontmatter attribution into the sidecar.

The `skills` CLI's own `skills-lock.json` is treated as *enrichment*, not the source of
truth: it is untracked **and** git-excluded, so `git clean`/branch churn can delete it at
any time (this happened in practice and silently collapsed all grouping to "Other
skills"). The sidecar is written from an install-time disk diff, so grouping and the NEW
badge no longer depend on the lock surviving.

### Scopes

Listing walks project dirs (`.agents/skills`, `.claude/skills`) *and* global dirs
(`~/.claude/skills`, `~/.config/claude/skills`, `~/.agents/skills`), tagging each skill
with its `scope`. Name dedup happens only **within** a scope (`.agents` beats `.claude` —
they're two copies of the same install). A project and a global skill with the same name
are **both listed**; name-keyed consumers (injection, task selections) resolve
project-first. Dot-directories (e.g. gstack's `.gstack-<v>.bak` backups) are skipped.
Global skills can be enabled/disabled per-workspace (stored in the sidecar's `global`
map, never written into the home directory) but **cannot be deleted from Kanban**.

## Install flow

`installSkill(workspacePath, source, skillNames?)` in
`src/workspace/workspace-skill-service.ts`:

1. Normalize `source` with `parseSkillsShSource` (`src/core/api-contract.ts`), which turns
   a skills.sh URL (`https://www.skills.sh/owner/repo[/skill]`), a GitHub URL, or a bare
   `owner/repo` slug into `{ repo, skill? }`. A skill named in the URL becomes a `--skill`
   filter unless the caller passed explicit `skillNames`.
2. Snapshot the on-disk project skill set, then run
   `npx skills add <repo> --agent claude-code --agent cline --copy --yes -p [--skill …]`.
   CLI failures are rewritten into readable errors (`formatSkillsCliError`) — e.g. the
   CLI's "No matching skills found for: …" plus the available names — instead of a raw
   exec dump.
3. Diff the disk again and return `{ installedNames, warnings }`. The diff (not the CLI
   exit code) decides what was installed: the CLI exits 0 even when a "whole collection"
   contains a single skill or everything already existed. Warnings flag installs that
   overwrote a same-named skill from another source and installs that shadow a global
   skill. The UI toasts report exactly this instead of a blanket "installed successfully".
4. Stamp `installedFrom` + `installedAt` for the newly added names into the sidecar.
5. Call `ensureSkillGitExcludes(workspacePath)` so the freshly-written skill files don't
   show up as project changes (see [Diff hygiene](#diff-hygiene)).

`listSkills` reads skill directories **directly from disk** (see [Scopes](#scopes)),
parsing each `SKILL.md` the same way the CLI does (a listable skill needs a non-empty
`name` and `description`; `metadata.internal` skills are hidden). This avoids the slow
`npx skills list` cold-start on a hot path. A short-lived (3s) in-memory cache,
invalidated by every mutation below, coalesces the picker and Settings panel both listing
at once. `createSkill`, `removeSkill`, and `setSkillDisabled` round out the CRUD surface.
All of this is exposed over tRPC as `workspace.skills{List,Install,Create,Remove,SetDisabled}`
(`src/trpc/app-router.ts` → `src/trpc/workspace-api.ts`).

## Remove flow

`removeSkill` never trusts the CLI: `npx skills remove <name> -p` **exits 0 even when it
removes nothing** (e.g. the name only matches a global skill), which used to make deleted
skills "come back" after the optimistic UI reconciled. The flow is: refuse global-scope
targets outright (Kanban never deletes outside the project), run the CLI remove, then
post-verify by force-removing any remaining `.agents/skills/<name>` and
`.claude/skills/<name>` copies, and clean up the skill's `skills-lock.json` and sidecar
entries. The Settings panel refetches from disk after a successful remove rather than
trusting its optimistic state.

## UI

- **Settings → Skills** is a top-level settings entity (`runtime-settings-dialog.tsx`),
  rendered by `web-ui/src/components/workspace-skills-panel.tsx`. Skills are shown in
  collapsible groups keyed by `installedFrom`, with "Other skills" and then "Global
  skills" always last; recently-installed skills get a "NEW" badge (48h window, driven by
  the sidecar `installedAt`). Global rows show a globe icon instead of a delete button.
  Toggling is **optimistic**; deleting reconciles with a refetch.
- Both the Settings panel and the per-task picker read the list through a shared
  stale-while-revalidate cache (`web-ui/src/runtime/workspace-skills-cache.ts`): the result
  is cached per workspace, reused across mounts, prefetched on board load (`App.tsx`), and
  invalidated by mutations — so re-opening "Override Agent Settings" is instant instead of
  re-fetching each time.
- **Per-task selection** lives in the task's Advanced tab
  (`web-ui/src/components/task-agent-model-picker.tsx`): the same source groups, a
  per-group select-all toggle, and only *enabled* skills are offered. Global skills are
  selectable (injection copies from their absolute path), except globals shadowed by a
  same-named project skill — selections are name-keyed and the project copy would win,
  so the shadowed row is dropped rather than shown as a dead toggle.
- **Changing skills on a running task** (`task-skills-button.tsx` in the card detail
  control bar) syncs the worktree files, then — for CLI agents, which snapshot their
  skill list at process start — prompts a confirm-then-restart (reusing the env-restart
  machinery via `onRestartTaskEnv`; the agent resumes its persisted session). The
  in-process Cline agent needs no restart.
- Shared helpers are in `web-ui/src/components/skills/` (`skill-grouping.ts`,
  `skill-new-badge.tsx`, `skill-switch.tsx`). The grouping/URL-parsing logic is imported
  from the backend contract via the `@runtime-contract` Vite alias.

## Per-task injection

When a task session starts (`src/trpc/runtime-api.ts`), `injectSkillsForAgent` runs with
the task's selected skill names, the worktree path (`taskCwd`), and the workspace path.
See `src/workspace/skill-injector.ts`:

- **Cline** — copies each selected skill into `<worktree>/.agents/skills/<name>`.
- **Claude** — copies into both `<worktree>/.agents/skills/<name>` and
  `<worktree>/.claude/skills/<name>`, writes a `CLAUDE.local.md` block pointing at them,
  and writes `<worktree>/.claude/settings.local.json` for isolation (below).

Injection is best-effort: failures must not block session start.

## Isolation: only show the skills the user selected

Selection alone is additive (agents still discover their own globals), so we additionally
hide the rest **where the agent supports it**.

### Claude Code — supported, mostly complete

`ClaudeSkillInjector.writeSkillOverrides` writes `<worktree>/.claude/settings.local.json`:

- `disableBundledSkills: true` drops Claude's built-in skills.
- `skillOverrides` maps every discoverable non-selected skill to `"off"`, which removes it
  from Claude's context entirely. Discoverable names are enumerated by
  `listDiscoverableClaudeSkillNames` (`src/workspace/skill-isolation.ts`) across
  `~/.claude/skills`, `~/.config/claude/skills`, `~/.agents/skills`, and the worktree's
  `.claude/skills` + `.agents/skills`.

Verified empirically against a real `claude` install: personal and bundled skills are
hidden, and passing `--settings` (which Kanban already does for hooks) does **not**
suppress the project `settings.local.json`, so the two coexist.

**Limitation — plugin skills.** Marketplace plugin skills (`<plugin>:<skill>`, e.g.
`imbue-code-guardian:*`) are *not* hidden by `skillOverrides` in either the namespaced or
bare form, and there is no per-run settings field to disable plugins (only managed-settings
marketplace blocking exists). They remain visible to Claude.

### Cline — worktree-only

Cline exposes no per-run knob to change its skill directory or hide globally-installed
skills (`~/.cline/skills`, `~/.agents/skills`). We control only the worktree contents, so
Cline sees the selected skills **plus** the user's globals. This is a deliberate tradeoff
(avoids invasive `HOME` swapping that would risk Cline's auth/config).

## Diff hygiene

Injected and installed skill files are untracked, and Kanban's "changed files" view runs
`git status --untracked-files=all`, so without intervention they show up as large diffs.
`ensureSkillGitExcludes(repoPath)` (`src/workspace/skill-git-exclude.ts`) adds a managed
block to the repo's `.git/info/exclude` covering `.agents/skills/`, `.claude/skills/`,
`.claude/settings.local.json`, `.cline/skills/`, `.clinerules/skills/`, `CLAUDE.local.md`,
and `skills-lock.json`. It is called at both install time (workspace) and injection time.

Two properties make this safe and broad:

- `info/exclude` lives in the **shared git common dir**, so one write covers the main
  checkout and every task worktree.
- git excludes only affect **untracked** files, so any skills a project legitimately tracks
  in git still show up in diffs normally.

## Key files

| Concern                         | File                                                  |
| ------------------------------- | ----------------------------------------------------- |
| Skill type + URL parser         | `src/core/api-contract.ts`                            |
| Install / list / CRUD           | `src/workspace/workspace-skill-service.ts`            |
| Per-task injection              | `src/workspace/skill-injector.ts`                     |
| Claude isolation helpers        | `src/workspace/skill-isolation.ts`                    |
| Diff-exclude management         | `src/workspace/skill-git-exclude.ts`                  |
| Session-start wiring            | `src/trpc/runtime-api.ts`                             |
| tRPC surface                    | `src/trpc/app-router.ts`, `src/trpc/workspace-api.ts` |
| Settings UI                     | `web-ui/src/components/workspace-skills-panel.tsx`    |
| Per-task picker UI              | `web-ui/src/components/task-agent-model-picker.tsx`   |
| Shared client cache + prefetch  | `web-ui/src/runtime/workspace-skills-cache.ts`        |
| Shared UI helpers               | `web-ui/src/components/skills/`                        |

## Known limitations (summary)

- Claude marketplace **plugin** skills cannot be hidden per-run.
- Cline shows the user's **global** skills in addition to the selected ones.
- Listing reads from disk and is cached, so it no longer pays the `npx skills list`
  cold-start. The trade-off: skill installs/edits made **outside** Kanban (or directly via
  the CLI) only show up after a Kanban mutation or once the 3s server cache expires.
- A repo is only as installable as the `skills` CLI sees it: some collections (e.g.
  `garrytan/gstack`) expose a single root `SKILL.md` to the CLI even though skills.sh
  renders per-skill pages, so "install whole collection" legitimately yields one skill.
  Kanban now reports exactly what was installed instead of pretending otherwise.
- Task skill selections are name-keyed; a global skill shadowed by a same-named project
  skill cannot be selected independently.
