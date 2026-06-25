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
| `name`         | skill directory name (from `npx skills list --json`)           |
| `description`  | `SKILL.md` frontmatter                                          |
| `disabled`     | `SKILL.md` frontmatter (`disabled: true`)                       |
| `dirPath`      | absolute path on disk                                           |
| `installedFrom`| `SKILL.md` frontmatter — the source slug, e.g. `anthropics/skills` |
| `installedAt`  | `SKILL.md` frontmatter — ISO timestamp stamped at install time |

`installedFrom`/`installedAt` are Kanban-managed frontmatter fields (the same channel the
codebase already uses for `disabled`). They power source grouping and the "NEW" badge.

## Install flow

`installSkill(workspacePath, source, skillNames?)` in
`src/workspace/workspace-skill-service.ts`:

1. Normalize `source` with `parseSkillsShSource` (`src/core/api-contract.ts`), which turns
   a skills.sh URL (`https://www.skills.sh/owner/repo[/skill]`), a GitHub URL, or a bare
   `owner/repo` slug into `{ repo, skill? }`. A skill named in the URL becomes a `--skill`
   filter unless the caller passed explicit `skillNames`.
2. Snapshot existing skill names, run `npx skills add <repo> --agent claude-code --agent
   cline --copy --yes -p [--skill …]`.
3. Stamp `installedFrom`/`installedAt` onto the newly-appeared skills
   (`stampInstallMetadata`).
4. Call `ensureSkillGitExcludes(workspacePath)` so the freshly-written skill files don't
   show up as project changes (see [Diff hygiene](#diff-hygiene)).

`listSkills` reads both project (`-p`) and global (`-g`) scopes via the CLI and merges
frontmatter metadata. `createSkill`, `removeSkill`, and `setSkillDisabled` round out the
CRUD surface. All of this is exposed over tRPC as `workspace.skills{List,Install,Create,
Remove,SetDisabled}` (`src/trpc/app-router.ts` → `src/trpc/workspace-api.ts`).

## UI

- **Settings → Skills** is a top-level settings entity (`runtime-settings-dialog.tsx`),
  rendered by `web-ui/src/components/workspace-skills-panel.tsx`. Skills are shown in
  collapsible groups keyed by `installedFrom`, each with a group-level enable/disable
  toggle; recently-installed skills get a "NEW" badge (48h window). Toggling and deleting
  are **optimistic** because the underlying `skills list` CLI is slow (1–2s).
- **Per-task selection** lives in the task's Advanced tab
  (`web-ui/src/components/task-agent-model-picker.tsx`): the same source groups, a
  per-group select-all toggle, and only *enabled* skills are offered.
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
`.claude/settings.local.json`, `.cline/skills/`, `.clinerules/skills/`, and
`CLAUDE.local.md`. It is called at both install time (workspace) and injection time.

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
| Shared UI helpers               | `web-ui/src/components/skills/`                        |

## Known limitations (summary)

- Claude marketplace **plugin** skills cannot be hidden per-run.
- Cline shows the user's **global** skills in addition to the selected ones.
- `skills list` is slow; the Settings panel hides this with optimistic updates, but a
  fresh load still pays the CLI cost.
