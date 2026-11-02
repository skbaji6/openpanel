# Marketing plugin: agent instructions

Spec: `docs/superpowers/specs/2026-10-28-marketing-platform-design.md`.
Plan: `docs/superpowers/plans/2026-11-02-marketing-phase1.md`.

The section below is quoted verbatim from the spec and binds every agent and implementer.

## Fork discipline (binding on every agent and implementer)

This repository is a fork of upstream OpenPanel and must stay updatable from
upstream at any time. **Do not modify, rename, move, reformat or delete any
existing file or directory.** That includes `packages/core`, `packages/db`
(including `prisma/schema.prisma` and its migrations), `apps/api`,
`apps/start`, root configs, `AGENTS.md`/`CLAUDE.md`, and tests. Do not run
formatters, `bun run fix` or codemods over files you did not create.

- All plugin code lives in **new files**: the service, migrations, docs and
  tests under `packages/marketing/`; the dashboard UI under new directories in
  `apps/start/src/` (e.g. `components/marketing/`) plus new route files in
  `apps/start/src/routes/`. The UI is not imported from `packages/marketing`
  (review finding: `apps/start` can only resolve dependencies in its own
  `package.json`, and Tailwind would not scan another package). It talks to the
  service over HTTP and keeps its own zod contract copy.
  Adding a new file in an existing directory is fine; editing an existing file
  is not.
- Deploy wiring is new files too (e.g. `docker-compose.marketing.yml`), not edits
  to `docker-compose.yml`.
- Plugin agent instructions go in `packages/marketing/AGENTS.md` (new), never in
  the root `AGENTS.md`.
- Use only public package surfaces. Never import `@openpanel/core` internals
  or reach into another package's `src/`.
- **Allowlist of unavoidable edits to existing files** (each needs the user's
  explicit approval before it is made, and is recorded in
  `packages/marketing/TOUCHPOINTS.md`): (1) one nav entry in
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

The spec is the source of truth; its "Recorded deviations" section lists where the code differs.

- Audience source (`src/audience/`): `AudienceSource` interface with an `http` client (`http-source.ts`: signing, retries, 8 MiB cap, breaker, cross-replica limiter) and the stored source; per-project settings in `marketing.audience_sources` (routes in `src/api/routes-audience-source.ts`, secret encrypted, migrations 0007 and 0008). Contract and signing: `docs/AUDIENCE_CONTRACT.md`. Reference server: `examples/audience-api-postgres/`. Conformance suite: `conformance/` (seed contract in `conformance/seed/`). Cut-over plan: `docs/CUTOVER_BACKEND_JOURNEYS.md`.
- Dedicated database: `MARKETING_DATABASE_URL`, falling back to `DATABASE_URL`. Dead push tokens are kept as hashes in `marketing.dead_tokens` (migration 0009, `src/engine/dead-tokens.ts`). Source settings: `MARKETING_SOURCE_CONCURRENCY`, `MARKETING_LOOKUP_WINDOW_MS`, `MARKETING_MAX_LATENESS`. `MARKETING_LEASE_SECONDS` must exceed the lookup window + 31 s. Steps overdue by more than `MARKETING_MAX_LATENESS` are skipped as `expired` for both sources.
- Personal data: contact fields live in memory for one batch (`src/engine/pii.test.ts` is the canary); never persist or log them.
- One worker process (`src/worker.ts`): Kafka consumer, ticker, daily purge and the HTTP API. Own consumer group, `fromBeginning: false`.
- Schema `marketing` in core's Postgres, plain SQL migrations in `migrations/` applied at startup; never touch `public`.
- Consumer (`src/kafka/`): pre-filter on a Redis interest set before any Postgres call; projects with an inactivity rule keep every identified event. Each batch is one transaction under the rules lock and per-profile advisory locks.
- Engine (`src/engine/engine.ts`): one `events` table is both dedupe and goal facts; enrollments carry a rule snapshot; goals are evaluated in event time; `end_reason` records goal / exhausted / rule_stopped.
- Ticker (`src/engine/ticker.ts`): claims due steps in order with row leases, rechecks the goal, applies opt-out, quiet hours and caps, sends through a channel adapter (`src/channels/`), gated by consumer lag.
- HTTP (`src/api/`): dashboard routes behind the shared proxy secret, sync routes behind per-project API keys, signed unsubscribe links; rate limiting and secret redaction on every logged error.
- Dashboard (`apps/start/src/components/marketing/`): talks to the worker only through its `/marketing-api/*` proxy and keeps its own zod copy (`contract.ts`, checked by a drift test).
- `scripts/load.ts` measures the performance targets against a `*_test` database; `scripts/e2e.ts` proves the path on a running stack.
