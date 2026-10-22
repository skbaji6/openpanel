# Nudge plugin: agent instructions

Spec: `docs/superpowers/specs/2026-10-22-journey-nudge-plugin-design.md`.
Plan: `docs/superpowers/plans/2026-10-22-journey-nudge-plugin.md`.

The section below is quoted verbatim from the spec and binds every agent and implementer.

## Fork discipline (binding on every agent and implementer)

This repository is a fork of upstream OpenPanel and must stay updatable from
upstream at any time. **Do not modify, rename, move, reformat or delete any
existing file or directory.** That includes `packages/core`, `packages/db`
(including `prisma/schema.prisma` and its migrations), `apps/api`,
`apps/start`, root configs, `AGENTS.md`/`CLAUDE.md`, and tests. Do not run
formatters, `bun run fix` or codemods over files you did not create.

- All plugin code lives in **new files**: the service, migrations, docs and
  tests under `packages/nudge/`; the dashboard UI under new directories in
  `apps/start/src/` (e.g. `components/nudge/`) plus new route files in
  `apps/start/src/routes/`. The UI is not imported from `packages/nudge`
  (review finding: `apps/start` can only resolve dependencies in its own
  `package.json`, and Tailwind would not scan another package). It talks to the
  service over HTTP and keeps its own zod contract copy.
  Adding a new file in an existing directory is fine; editing an existing file
  is not.
- Deploy wiring is new files too (e.g. `docker-compose.nudge.yml`), not edits
  to `docker-compose.yml`.
- Plugin agent instructions go in `packages/nudge/AGENTS.md` (new), never in
  the root `AGENTS.md`.
- Use only public package surfaces. Never import `@openpanel/core` internals
  or reach into another package's `src/`.
- **Allowlist of unavoidable edits to existing files** (each needs the user's
  explicit approval before it is made, and is recorded in
  `packages/nudge/TOUCHPOINTS.md`): (1) one nav entry in
  `apps/start/src/components/sidebar-project-menu.tsx` (**approved by the
  user**; one `<SidebarLink>` element only, formatted the way the repo's
  formatter formats the neighbouring links, reusing the already-imported
  `WorkflowIcon` so the import block is not touched; for now, until upstream
  offers a plugin hook); (2) regenerated
  `apps/start/src/routeTree.gen.ts` and `bun.lock`, which tooling rewrites and
  which are regenerated, not hand-merged, on upstream updates. Anything not on
  this list: stop and ask the user. Do not work around the rule.
- If a task seems to require editing an existing file, treat it as a design
  problem to raise, not permission to edit.
- Every implementation plan and every subagent prompt for this work must
  quote this section.

## How it is built (decisions made)
