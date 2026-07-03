# Skills feature overhaul — findings & fix plan

Date: 2026-07-04. Triggered by four user-reported symptoms. Every root cause below was
verified empirically (scratchpad installs with `skills` CLI v1.5.14) or on the actual
workspace disk state — none are guesses.

## Symptoms → root causes

### 1. "Whole collection" install of `garrytan/gstack` shows only one skill

Verified: `npx skills add garrytan/gstack --copy -p` finds **exactly 1 installable
skill** — the `gstack` router (the repo's root `SKILL.md`). The sub-skill pages on
skills.sh (`/garrytan/gstack/qa` etc.) are not installable by the `skills` CLI:
`--skill qa` fails with `No matching skills found for: qa` (exit 1). The gstack suite
visible in `~/.claude/skills` was installed globally by gstack's *own* installer, not by
the skills CLI. So this half is upstream repo structure — Kanban cannot install what the
CLI can't enumerate.

Kanban's contribution to the confusion: `performInstall` toasts **"Skill installed
successfully"** unconditionally, reporting nothing about what was actually installed
(`installSkill` returns `void`). Installing a "whole collection" that yields 1 skill
looks identical to one that yields 20.

### 2. gstack's `qa` never shows — name-collision shadowing

`readSkillsFromDisk` (`src/workspace/workspace-skill-service.ts`) merges project dirs
(`.agents/skills`, `.claude/skills`) and global dirs (`~/.claude/skills`,
`~/.config/claude/skills`, `~/.agents/skills`) into one list **deduped by `name`,
project-first**. The workspace has mattpocock's `qa` at project scope; gstack's `qa` is
global → permanently shadowed, silently. There is no `scope` in
`RuntimeWorkspaceSkill`, no disambiguation, no indication a shadow happened.

### 3. Deleted skills reappear

Two verified causes in `removeSkill`:

- **Global-only skills:** `npx skills remove <name> --yes -p` exits **0** with "No
  skills found to remove" when the skill isn't project-scoped. The `catch` fallback
  (direct `rm` of `dirPath`) therefore never runs. Nothing is deleted; the optimistic UI
  hides the row; the next refetch resurrects it. All gstack suite skills are global, so
  every delete of them was a silent no-op.
- **No post-verify:** the CLI's success is trusted blindly; the `skills-lock.json` entry
  is never cleaned either (verified: lock still lists `gstack` after removal).

(When the skill *is* project-scoped, CLI remove correctly deletes both `.agents` and
`.claude` copies.)

### 4. Grouping collapsed to "Other skills" + NEW badge unreliable

The workspace's `skills-lock.json` is **gone** (it existed 2026-07-03 when `installedAt`
was stamped on `qa`/`gstack`). It's untracked *and* git-excluded
(`ensureSkillGitExcludes`), so `git clean -fdx` / branch churn can delete it at any
time. Consequences when absent:

- `installedFrom` resolves to `undefined` for everything → the Settings panel shows one
  flat "Other skills" group.
- `stampInstallTimestamps` filters `s.installedFrom === repo` (lock-derived) → matches
  nothing → newly installed skills never get `installedAt` → **no NEW badge, ever**.

Additional fragility: `installedAt` is stamped only on the dedup-winning copy
(`.agents/skills/<name>/SKILL.md`); the `.claude` copy has none (verified on disk). If
the winner changes (e.g. `.agents` copy removed), the badge and grouping metadata
vanish. And stamping frontmatter **mutates SKILL.md**, invalidating the lock's
`computedHash` integrity record.

### 5. Running Claude Code session doesn't see newly added skills

`TaskSkillsButton` claims "the agent picks them up on its next turn — no session restart
needed". Wrong for Claude Code: the skill list *and* `.claude/settings.local.json`
(`skillOverrides`) are snapshotted at process start. `syncTaskSkills` →
`syncSkillsForAgent` correctly updates the worktree files, but the live process never
rescans.

### Minor

- Dot-directories (e.g. gstack's `~/.claude/skills/.gstack-1.46.0.0.bak` backup) are
  listed as skills.
- Lock entries accumulate stale rows after removals.

## Decisions (user-confirmed 2026-07-04)

1. **Global skills:** separate "Global" section with scope badge; enable/disable
   allowed; **no delete** — Kanban never deletes files outside the project.
2. **NEW badge:** keep 48h window semantics, make the timestamp reliable.
3. **Live sync on running Claude Code tasks:** confirm-then-restart, mirroring the
   `restartTaskSessionEnv` flow (agent resumes its conversation from disk).

## Plan

### Phase 1 — Scope-aware data model & listing

`src/core/api-contract.ts`, `src/workspace/workspace-skill-service.ts`, panel + picker.

- Add `scope: "project" | "global"` to `RuntimeWorkspaceSkill`.
- Dedup only **within** project scope (`.agents` beats `.claude` — same install
  duplicated by the CLI). Global skills are listed separately and never shadowed by a
  project skill of the same name.
- Skip dot-directories when walking skill roots.
- Settings panel: project groups as today, then a "Global" section (scope badge,
  toggle, no delete button; server rejects `skillsRemove` for global scope with a clear
  error).
- Per-task picker: globals selectable for injection (injection already copies from the
  absolute `dirPath`). On a project/global name collision, resolution prefers project;
  surface a small "shadows a global skill with the same name" hint.
- Global disable state must NOT write into `~/.claude/skills/*/SKILL.md` (affects other
  projects/tools) — store it in the Phase 2 sidecar instead.

### Phase 2 — Kanban sidecar metadata; stop mutating SKILL.md

- New `<workspace>/.agents/skills-meta.json` (git-excluded alongside the rest):
  `{ [skillName]: { installedFrom, installedAt, disabledGlobal? } }`.
- At install time, record `installedFrom`/`installedAt` by **diffing the on-disk skill
  set before/after** the CLI run — no lock dependence. Keep reading `skills-lock.json`
  as enrichment when present.
- Migration: on first list, backfill the sidecar from legacy frontmatter
  (`installedFrom`/`installedAt`) and the lock; keep legacy frontmatter reads as
  fallback; stop writing frontmatter entirely (fixes the `computedHash` breakage).
- Project-skill `disabled`: keep honoring frontmatter as read-only input, but move
  Kanban's own writes to the sidecar too (same hash-breakage reason). `setSkillDisabled`
  becomes a sidecar write.

### Phase 3 — Honest install reporting

- `installSkill` returns `{ installedNames: string[] }` (before/after diff).
- Toasts: "Installed 3 skills from owner/repo: a, b, c"; for a whole-collection install
  yielding one skill, say so explicitly.
- Surface CLI failures legibly (e.g. `No matching skills found for: qa` + the available
  names from stderr) instead of a generic exec error.
- Pre-check name collisions against existing skills from *other* sources and warn.

### Phase 4 — Verified remove

- After CLI remove, re-read disk bypassing the 3s cache; if the name still resolves at
  project scope, `rm` both `.agents/skills/<name>` and `.claude/skills/<name>` directly.
- Clean the `skills-lock.json` entry and sidecar entry.
- Return the fresh list so the client cache is updated from truth, not optimism.

### Phase 5 — Reliable NEW badge

- `installedAt` comes from the sidecar (stamped via install diff), independent of lock
  presence, frontmatter, or which copy wins dedup. 48h window unchanged
  (`SKILL_NEW_WINDOW_MS`).

### Phase 6 — Live-task skill changes restart Claude Code

- Keep `syncTaskSkills` (worktree files + `settings.local.json` rewrite), then for CLI
  agents show a confirm dialog ("Restart agent to apply skill changes?") and reuse the
  `forceRestartOnExit` restart machinery from `restartTaskSessionWithEnv` (generalize or
  add a sibling `restartTaskSessionSkills`). Agent resumes from its on-disk session.
- Verify whether in-process Cline picks up worktree `.agents/skills` changes per turn;
  if yes, keep no-restart behavior for Cline.
- Fix the `TaskSkillsButton` popover copy either way.

### Phase 7 — Tests & docs

- Unit tests: scope-aware listing/dedup, dot-dir skip, install diff reporting, remove
  verification (mock the CLI's exit-0 no-op), sidecar migration/backfill, badge
  stamping, global-delete rejection.
- Update `docs/skills.md` (data model, sidecar, remove semantics, restart flow) and add
  an AGENTS.md tribal note: `npx skills remove -p` exits 0 when it removes nothing.

## Sequencing

1+4 first (they fix the outright lies: shadowed skills, no-op deletes), then 2+5
(durable metadata, grouping, badge), then 3 (messaging), then 6 (live-session restart),
7 throughout.

## Notes for the user's current workspace

- The missing `skills-lock.json` stops mattering after Phase 2 (sidecar backfill from
  frontmatter restores grouping for `qa`/`gstack`; future installs are self-recording).
- The gstack *suite* is simply not installable via the skills CLI from
  `garrytan/gstack` (upstream). The globally-installed suite already covers it; after
  Phase 1 gstack's `qa` will finally be visible as a global skill alongside mattpocock's
  project-scoped `qa`.
