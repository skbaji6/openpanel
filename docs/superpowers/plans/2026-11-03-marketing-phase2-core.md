# Marketing Phase 2, Plan 1 of 3: Audiences and Campaigns Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved audiences with full selection control (filters, hand-picked ids, exclusions, snapshot or dynamic), campaigns with a state machine, safety gates and schedules, and a resumable materialiser that turns an audience into an ids-only recipient list, all behind the worker's dashboard API.

**Architecture:** New Postgres tables (migrations 0011 and 0012) hold audience definitions, id lists, snapshots, campaigns, recipients, counters and test-send requests, ids only. `src/audience/` gains the definition model, the builder (count, preview, explain, resolve) and the materialiser; `src/campaign/` holds the pure state machine, the campaign service and two worker jobs (schedule claimer, materialise runner) that coordinate replicas only through row claims and leases. Routes follow `src/api/routes-dashboard.ts`; role rules live in the dashboard proxy as in Phase 1. Plan 2 adds the dispatch lane and channel adapters on top of `campaign_recipients`; plan 3 adds the dashboard UI.

**Tech Stack:** Bun, TypeScript, zod, Postgres (plain-SQL migrations, own runner), Redis (source limiter), bun test.

**Spec:** `docs/superpowers/specs/2026-10-28-marketing-platform-design.md`, sections 6.1, 6.2, 6.3 (materialise only), 6.4 (materialise targets), 8 (Phase 2 items for audiences and materialisation), 9 (calls 5, 7, 20, 22, 27). Also binding: `packages/marketing/docs/AUDIENCE_CONTRACT.md`, the Phase 1 plan `docs/superpowers/plans/2026-11-02-marketing-phase1.md` and every `Ruling:` line in `.superpowers/sdd/2026-11-02-marketing-phase1/progress.md`.

**Out of scope here:** dashboard UI (plan 3), dispatch lane, lookup, rendering, channel adapters, template registry, frequency-cap ledger, quiet-hours release, email quota (plan 2). No message is sent by anything in this plan.

## Global Constraints

Every task includes these.

- **Fork discipline (quoted from `packages/marketing/AGENTS.md`, binding):** "This repository is a fork of upstream OpenPanel and must stay updatable from upstream at any time. **Do not modify, rename, move, reformat or delete any existing file or directory.** That includes `packages/core`, `packages/db` (including `prisma/schema.prisma` and its migrations), `apps/api`, `apps/start`, root configs, `AGENTS.md`/`CLAUDE.md`, and tests. Do not run formatters, `bun run fix` or codemods over files you did not create. All plugin code lives in **new files** [...]. Use only public package surfaces. Never import `@openpanel/core` internals or reach into another package's `src/`. [...] If a task seems to require editing an existing file, treat it as a design problem to raise, not permission to edit." Files this plugin created (everything under `packages/marketing/` and `apps/start/src/components/marketing/`) may be edited. `bun packages/marketing/scripts/check-fork.ts` must pass after every task (base `f019500c`: only `A` plus the three allowed `M`). `check-rename.ts` must pass: no `nudge` in any new path, identifier, string or test name.
- **No real sends.** No test, script or route in this plan calls a provider, an SMTP server, FCM or MSG91. Audience calls in tests go to the fake source (Task 3) or the in-repo reference service.
- **Ids only.** No email, phone, name, device token or masked display name is written to any `marketing` table, Redis key or log line. Pasted phones or emails exist only in memory for one `/members/resolve` call and are never echoed in an error, log or stored row. Masked names from `preview` are returned to the caller and never stored.
- **Contract limits (from Phase 1, unchanged):** filter depth 3; `members` limit at most 1,000; `id` condition `in`/`not_in` at most 1,000 values; `resolve` at most 200 inputs; `MARKETING_SOURCE_CONCURRENCY` default 4, global across replicas; journeys have priority on that cap.
- **Spec values pinned here:** hand-picked and excluded lists at most 20,000 ids each; confirmation for audiences over 5,000 (`MARKETING_CONFIRM_THRESHOLD`, default 5000); default timezone `Asia/Kolkata`; `ifLate` default 60 minutes; one running campaign per project; campaign states `draft, scheduled, running, paused, completed, cancelled, failed, missed`.
- **Commits.** `<type>(marketing): <subject>`, imperative, lower case, no period. Never `!`, `BREAKING CHANGE:`, `[major]`, `[minor]` or `[release now]`; describe upgrade impact (new migrations, new env) in the body. End with the attribution trailer the executing session's system reminder specifies. Never push, never add remotes, never rewrite history.
- **Formatting and checks.** `npx ultracite fix <files you changed>` and `bun run typecheck` before each commit; never format files you did not create.
- **Test environment (Windows, Git Bash, learnt in Phase 1).** Run `bun test --isolate` from `packages/marketing` with `MARKETING_ALLOW_RESET=1`, `DATABASE_URL` pointing at a database whose name ends in `_test` (Phase 1 used `openpanel_nudge_test`) and `REDIS_URL` on db index 6. The Docker containers are compose project `nudge` (`docker compose -p nudge up -d op-db op-kv op-rp`); Kafka tests fail with ECONNREFUSED if Redpanda is down. Stop local dev processes before moving files (Windows file locks). Strip `?schema=public` from a Prisma `DATABASE_URL` before handing it to anything else. Spawn child services with `process.execPath`, not a `bun` shim. `db/client.test.ts` can time out on a cold start: rerun it alone before treating it as a failure. `.logs/` and `bash.exe.stackdump` are excluded locally through `.git/info/exclude`; keep them out of commits.
- **Phase 1 rulings that bind this plan:** limiter waits surface as `SourceBusyError` (try later, never a failure); `SourceUnavailableError`, `SourceBusyError` and `SourceAuthError` never mark anything failed; `SourceAuthError` sets `audience_sources.status = 'source_auth_failed'`; role checks live in `apps/start/src/components/marketing/proxy.ts` (`ALLOWED_ROUTES`), unlisted routes 404 (fail closed); dimension values are `{values:[{value,label}]}`; the signed path is the WHATWG-normalised pathname plus search; filter depth counts groups and a lone condition counts 1.

## Review Focus

Failure modes the spec implies that no task would otherwise pin. Each has its test in the named task.

1. An operator pastes 20,000 ids: a single JSON body of that size exceeds the 1 MiB body cap of the worker and the proxy. Expected: ids are edited in chunks of at most 2,000 per call; the 20,000 cap is enforced across chunks (Tasks 7, 11).
2. Folding up to 1,000 excluded ids into the filter as `id not_in` wraps a depth-3 filter into depth 4, which the API rejects, so the campaign fails. Expected: append to a top-level AND group, otherwise subtract in the plugin (Task 2).
3. The audience is edited while a campaign that uses it is scheduled or running. Expected: the edit is refused with `audience_in_use`; the recipient list never mixes two versions (Task 7).
4. Two replicas tick the scheduler at the same moment, or two campaigns of one project come due together. Expected: each campaign starts once, at most one campaign per project is running or paused, the other stays scheduled (Task 10).
5. The audience API returns a page with an id repeated from an earlier page, an empty or over-256-character id, or a `nextCursor` equal to the cursor it was given. Expected: duplicates collapse silently, bad ids and a non-advancing cursor are a `SourceProtocolError`, never an endless loop (Task 6).

---

### Task 1: Schema for audiences, campaigns and recipients

**Files:**
- Create: `packages/marketing/migrations/0011_audiences.sql`, `packages/marketing/migrations/0012_campaigns.sql`, `packages/marketing/src/campaign/schema.test.ts`

**Interfaces:**
- Produces (all in schema `marketing`; every table except the child tables carries `project_id text NOT NULL`):
  - `audiences(id uuid PK, project_id, name text NOT NULL, mode text NOT NULL CHECK (mode IN ('dynamic','snapshot')), filter jsonb NULL, exclude_filter jsonb NULL, version int NOT NULL DEFAULT 1, snapshot_version int NULL, snapshot_count int NULL, snapshot_at timestamptz NULL, schema_checked_at timestamptz NULL, created_by text NOT NULL, created_at, updated_at)`; index `(project_id, updated_at DESC)`.
  - `audience_ids(audience_id uuid NOT NULL REFERENCES audiences ON DELETE CASCADE, list text NOT NULL CHECK (list IN ('include','exclude')), profile_id text NOT NULL, PRIMARY KEY (audience_id, list, profile_id))`.
  - `audience_snapshot_ids(audience_id uuid REFERENCES audiences ON DELETE CASCADE, snapshot_version int, profile_id text, PRIMARY KEY (audience_id, snapshot_version, profile_id))`.
  - `campaigns(id uuid PK, project_id, name text NOT NULL, state text NOT NULL CHECK (state IN ('draft','scheduled','running','paused','completed','cancelled','failed','missed')), state_reason text NULL, channel text NOT NULL CHECK (channel IN ('push','whatsapp','sms','email','webhook')), template jsonb NOT NULL, audience_id uuid NULL REFERENCES audiences ON DELETE RESTRICT, audience_version int NULL, campaign_key text NULL, skip_previous_recipients boolean NOT NULL DEFAULT false, send_kind text NULL CHECK (send_kind IN ('now','scheduled')), send_at timestamptz NULL, send_at_local text NULL, timezone text NOT NULL DEFAULT 'Asia/Kolkata', if_late_minutes int NOT NULL DEFAULT 60 CHECK (if_late_minutes BETWEEN 0 AND 1440), quiet_hours_override jsonb NULL, frequency_cap jsonb NULL, confirm_threshold int NOT NULL, count_preview jsonb NULL, materialize_state text NOT NULL DEFAULT 'not_started' CHECK (materialize_state IN ('not_started','in_progress','done','failed')), materialize_phase text NULL, materialize_cursor text NULL, materialize_lease_token uuid NULL, materialize_lease_until timestamptz NULL, materialize_retry_at timestamptz NULL, materialize_error text NULL, materialize_attempts int NOT NULL DEFAULT 0, version int NOT NULL DEFAULT 1, created_by text NOT NULL, created_at, updated_at, started_at timestamptz NULL, finished_at timestamptz NULL)`.
  - Campaign indexes: `campaigns_one_active_per_project UNIQUE (project_id) WHERE state IN ('running','paused')`; `campaigns_due_idx (send_at) WHERE state = 'scheduled'`; `campaigns_materialize_idx (materialize_retry_at) WHERE materialize_state IN ('not_started','in_progress') AND state IN ('running','paused')`; `(project_id, created_at DESC)`; `(project_id, campaign_key) WHERE campaign_key IS NOT NULL`.
  - `campaign_recipients(campaign_id uuid NOT NULL REFERENCES campaigns ON DELETE CASCADE, profile_id text NOT NULL, project_id text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','sending','sent','uncertain','failed','skipped')), reason text NULL, attempt int NOT NULL DEFAULT 0, due_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz NULL, idempotency_key text GENERATED ALWAYS AS (campaign_id::text || ':' || profile_id) STORED, provider_ref text NULL, sent_at timestamptz NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (campaign_id, profile_id))`; indexes `campaign_recipients_claim_idx (campaign_id, due_at) WHERE status = 'pending'` and `campaign_recipients_lease_idx (lease_until) WHERE status IN ('leased','sending')`.
  - `materialize_exclusions(job_id uuid NOT NULL, profile_id text NOT NULL, PRIMARY KEY (job_id, profile_id))` (staging; `job_id` is a campaign id or an audience id).
  - `campaign_counters(campaign_id uuid PK REFERENCES campaigns ON DELETE CASCADE, queued int NOT NULL DEFAULT 0, sent int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0, skipped int NOT NULL DEFAULT 0, uncertain int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`.
  - `campaign_test_sends(id uuid PK, campaign_id uuid NOT NULL REFERENCES campaigns ON DELETE CASCADE, project_id text NOT NULL, profile_id text NOT NULL, requested_by text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')), reason text NULL, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz NULL)`; index `(status, created_at) WHERE status = 'pending'`.
  - Use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, like 0007 to 0010.

- [ ] **Step 1: Write the failing tests** in `schema.test.ts` (after `migrate()` and `resetMarketingTables()`): `a second running campaign in one project violates campaigns_one_active_per_project` (expect Postgres code `23505`); `a paused and a running campaign in one project also conflict`; `two running campaigns in different projects are allowed`; `a recipient row has idempotency_key '<campaign_id>:<profile_id>'`; `inserting the same (campaign_id, profile_id) twice with ON CONFLICT DO NOTHING keeps one row`; `an unknown campaign state is rejected by the check`; `EXPLAIN of SELECT ... FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending' ORDER BY due_at LIMIT 500 FOR UPDATE SKIP LOCKED uses campaign_recipients_claim_idx` (seed 10,000 rows, `ANALYZE` first); `deleting an audience referenced by a campaign fails`.
- [ ] **Step 2: Run** `bun test src/campaign/schema.test.ts`; expect FAIL (tables missing).
- [ ] **Step 3: Write** both migration files.
- [ ] **Step 4: Run** the test file and `src/db/migrate.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): tables for audiences, campaigns and recipients` (body: migrations 0011 and 0012 run at startup).

---

### Task 2: Audience definition and validation

**Files:**
- Create: `packages/marketing/src/audience/definition.ts`, `src/audience/definition.test.ts`
- Modify: `src/audience/filter.ts` (export a structure-only check), `src/audience/filter.test.ts`

**Interfaces:**
- Consumes: `validateFilter`, `FilterTree`, `Schema`, `MAX_ID_CONDITION_VALUES`, `MAX_FILTER_DEPTH`, `RESERVED_ID_DIMENSION` (Phase 1); `zIdentifier` from `src/api/routes-sync.ts` (profile id format, at most 256 chars).
- Produces in `filter.ts`: `validateFilterStructure(filter: unknown): {ok: true; filter: FilterTree} | {ok: false; errors: string[]}` (zod shape, depth, value counts per op, the `id` rules; no dimension declaration or value-type checks; same no-echo error rule as `validateFilter`).
- Produces in `definition.ts`:
  - `MAX_LIST_IDS = 20_000`, `MAX_IDS_PER_CHANGE = 2_000`, `MAX_SNAPSHOT_IDS = 100_000`, `MAX_AUDIENCE_NAME = 200`.
  - `zAudienceInput = z.strictObject({name, mode: 'dynamic'|'snapshot', filter: unknown | null, excludeFilter: unknown | null})` and `zIdListChange = z.strictObject({list: 'include'|'exclude', add?: zIdentifier[] (max 2,000), remove?: zIdentifier[] (max 2,000), clear?: true})` (at least one of the three).
  - `interface AudienceDefinition { filter: FilterTree | null; excludeFilter: FilterTree | null; includeCount: number; excludeIds: string[] | null }` (`excludeIds` loaded only when at most 1,000, else null).
  - `checkAudienceInput(input: z.infer<typeof zAudienceInput>, schema: Schema | null): {ok: true; filter: FilterTree | null; excludeFilter: FilterTree | null} | {ok: false; errors: string[]}` (`validateFilter` when a schema is given, `validateFilterStructure` when null).
  - `buildSourceFilter(filter: FilterTree, excludeIds: string[] | null): {filter: FilterTree; pushedExcludes: boolean}`: when `excludeIds` is non-null and non-empty, add `{dimension: 'id', op: 'not_in', values: excludeIds}` as a child of a top-level `and` group, or wrap `{op:'and', children:[filter, cond]}` when the result stays within depth 3; otherwise return the filter unchanged with `pushedExcludes: false`.

- [ ] **Step 1: Write the failing tests**: `validateFilterStructure accepts depth 3 and rejects depth 4`; `validateFilterStructure rejects __proto__ keys, NUL in a value, a 100,000-character value and a 10,000-deep JSON nesting without throwing`; `checkAudienceInput with schema null accepts an undeclared dimension but rejects a malformed tree`; `checkAudienceInput with a schema rejects an undeclared dimension and the error text contains no input value`; `zIdListChange rejects 2,001 ids, an empty id, a 257-character id and a non-string id`; `buildSourceFilter appends not_in to a top-level and group (depth unchanged)`; `buildSourceFilter wraps a lone condition into and (depth 2)`; `buildSourceFilter leaves a depth-3 or-rooted filter unchanged with pushedExcludes false`; `buildSourceFilter with 1,001 excludes is given null and pushes nothing`; `a filter already containing an id condition keeps it`.
- [ ] **Step 2: Run** `bun test src/audience/definition.test.ts src/audience/filter.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `validateFilterStructure` by reusing the walk in `filter.ts` with the dimension checks skipped, and `definition.ts`.
- [ ] **Step 4: Run** the tests (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): audience definitions with include and exclude lists`.

---

### Task 3: Fake audience source for tests and load runs

**Files:**
- Create: `packages/marketing/src/audience/fake-source.ts`, `src/audience/fake-source.test.ts`

**Interfaces:**
- Consumes: `AudienceSource`, contract types, `SourceUnavailableError`.
- Produces: `interface FakeMember { id: string; values: Record<string, string | number | boolean | (string | number)[]>; displayName?: string; contact?: { phone?: string; email?: string } }`; `createFakeSource(opts: { members: FakeMember[]; schema?: Schema; pageDelayMs?: number; down?: () => boolean; sleep?: (ms: number) => Promise<void> }): AudienceSource & { calls: { method: string; filter?: FilterTree; cursor?: string; limit?: number }[]; sourceTimeMs: () => number }`. `members` sorts by id (string order), cursor is the last id of the page, `nextCursor` null at the end, `fields: 'preview'` returns `displayName`. `count` equals the number of ids `members` would page out. Filter evaluation: `eq`, `in`, `not_in`, `gt`, `lt`, `between`, `exists` over `values[dimension]` (a multi-valued dimension matches when any element matches; `not_in` on it means no element is in the list; `id` reads the member id). `resolve` matches `contact.phone` or `contact.email`. `explain` returns one `{dimension, op, matched}` per leaf. `down()` true makes every call throw `SourceUnavailableError('fake_down')`. `sourceTimeMs` sums the time spent inside calls, including `pageDelayMs`.

- [ ] **Step 1: Write the failing tests**: `pages 2,500 ids at 1,000 per page with no duplicates and a null final cursor`; `count equals ids paged for and, or and nested filters`; `not_in on a multi-valued dimension excludes a member with any listed value`; `between is inclusive at both ends`; `exists matches a present value only`; `resolve returns ids for known phones and lists unknown inputs as unmatched`; `down() makes members throw SourceUnavailableError`; `pageDelayMs is waited through the injected sleep and counted in sourceTimeMs`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** the fake.
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `test(marketing): in-memory audience source for audience and load tests`.

---

### Task 4: Campaign lane on the source concurrency cap

**Files:**
- Create: `packages/marketing/src/audience/lane.ts`, `src/audience/lane.test.ts`

**Interfaces:**
- Consumes: `createSourceLimiter(redis, {key, cap, slotTtlMs, maxWaitMs?})`, `AudienceSource`.
- Produces: `campaignLaneCap(sourceConcurrency: number): number` (`max(1, sourceConcurrency - 1)`); `withCampaignLane(source: AudienceSource, opts: { redis: Redis; projectId: string; sourceConcurrency: number; now?: () => number }): AudienceSource` which takes a slot in limiter key `<projectId>:campaign-lane` (Redis key `marketing:source-sem:<projectId>:campaign-lane`, slot TTL 30,000 ms) around every call before the source's own shared slot is taken, so campaign work never holds all shared slots and a journey lookup always finds one free. Only the materialiser uses the lane; dashboard builder calls do not.

- [ ] **Step 1: Write the failing tests** against the real test Redis with a fake inner source that holds each call open until released: `with concurrency 4 at most 3 campaign-lane calls run at once`; `a journey call through the shared limiter acquires while 3 campaign-lane calls are in flight`; `with concurrency 1 the lane cap is 1 and campaign calls still proceed`; `a lane wait over maxWaitMs throws SourceBusyError`; `an error inside the call releases the lane slot`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** with a second `createSourceLimiter`.
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): campaign lane keeps a source slot free for journeys`.

---

### Task 5: Audience builder: count, preview, explain, resolve

**Files:**
- Create: `packages/marketing/src/audience/builder.ts`, `src/audience/builder.test.ts`, `src/audience/builder.reference.test.ts`

**Interfaces:**
- Consumes: Task 2 `AudienceDefinition`, `buildSourceFilter`; Task 3 fake; `normalizeResolveInputs`, `MAX_RESOLVE_INPUTS`.
- Produces:
  - `interface AudienceCount { count: number; approximate: boolean; countedAt: string; filterCount: number | null; includeCount: number; excludeCount: number }`.
  - `countAudience(source: AudienceSource, def: AudienceDefinition & { excludeCount: number }, now: () => Date): Promise<AudienceCount>`: `count = (filterCount ?? 0) + includeCount`; `approximate` is true when the API says so, when a filter and includes are both present (overlap unknown), when an exclude filter is present, or when excludes were not pushed. An approximate count is always an upper bound (nothing is subtracted that the API did not subtract). A snapshot audience's count is its `snapshot_count`, exact, with `countedAt` = `snapshot_at` (handled by the caller in Task 7).
  - `previewAudience(source, def, cursor: string | undefined, limit: number): Promise<{ members: { id: string; displayName?: string }[]; nextCursor: string | null }>`: pages the source filter (with pushed excludes) with `fields: 'preview'`, `limit` at most 50; hand-picked ids are not part of preview (listed by Task 11's id-list route).
  - `explainAudience(source, def: { filter; excludeFilter; included: boolean; excludedByList: boolean }, id: string): Promise<{ id: string; verdict: 'in' | 'out'; reasons: ('matched_filter' | 'not_matched' | 'included' | 'excluded_by_list' | 'excluded_by_filter')[]; filter?: Explanation; excludeFilter?: Explanation }>`; precedence (spec 6.1): in = (matched filter or included) and not excluded by list or exclude filter.
  - `resolveInputs(source, raw: string[]): Promise<{ ids: string[]; unmatchedPositions: number[] }>`: normalises, rejects more than 200 with an error that echoes nothing, returns unique ids and the positions in `raw` of inputs that matched nothing; never returns or logs an input.

- [ ] **Step 1: Write the failing tests** (fake source): `count of a filter-only audience is exact`; `count with includes overlapping the filter is approximate and an upper bound` (actual set computed from the fake's data); `count with an exclude filter is approximate and an upper bound`; `count with 40 excludes pushes not_in and is exact`; `count with 1,500 excludes is approximate`; `preview limit 51 is rejected`; `preview never returns an excluded id when excludes were pushed`; `explain: a hand-picked id outside the filter is in with reason included`; `explain: an id matching the filter and the exclude filter is out with excluded_by_filter`; `explain: an excluded hand-picked id is out (exclusion wins)`; `resolve maps positions of unmatched inputs and returns no input text`; `resolve with 201 inputs throws before any source call`. In `builder.reference.test.ts`, start the reference service on the conformance seed the way `conformance/conformance.test.ts` does and assert `countAudience` and a full `previewAudience` walk agree with `conformance/seed/expected.json` for two filters there.
- [ ] **Step 2: Run** `bun test src/audience/builder.test.ts src/audience/builder.reference.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `builder.ts`.
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): audience count, preview, explain and paste-to-id resolve`.

---

### Task 6: Materialiser

**Files:**
- Create: `packages/marketing/src/audience/materialize.ts`, `src/audience/materialize.test.ts`

**Interfaces:**
- Consumes: Task 1 tables; Task 2 `buildSourceFilter`; `AudienceSource`, `SourceProtocolError`, `zIdentifier`.
- Produces:
  - `type MaterializePhase = 'exclusions' | 'members' | 'includes' | 'snapshot_copy'`; `interface MaterializeProgress { phase: MaterializePhase; cursor: string | null }`.
  - `type MaterializeTarget = { kind: 'campaign'; campaignId: string; campaignKey: string | null; skipPrevious: boolean; fromSnapshot: { audienceId: string; snapshotVersion: number } | null } | { kind: 'snapshot'; audienceId: string; snapshotVersion: number }`.
  - `interface MaterializeJob { jobId: string; projectId: string; audienceId: string; filter: FilterTree | null; excludeFilter: FilterTree | null; target: MaterializeTarget; progress: MaterializeProgress | null; saveProgress(tx: Queryable, next: MaterializeProgress | 'done', inserted: number): Promise<boolean> }` (false means the caller lost its claim; the page's transaction rolls back).
  - `runMaterialization(deps: { sql: Sql; source: AudienceSource; pageSize?: number; shouldStop?: () => Promise<boolean> }, job: MaterializeJob): Promise<{ status: 'done'; total: number } | { status: 'stopped' } | { status: 'lost_claim' }>`; default `pageSize` 1,000. Source errors propagate to the caller unchanged.
- Algorithm (not determined by the signature):
  1. `exclusions`: one statement copies the audience's `exclude` list into `materialize_exclusions(job_id)`; then, if `excludeFilter` is set, page it with `fields: 'id'` and insert each page into the same staging table.
  2. `members` (when `filter` is set): page `buildSourceFilter(filter, excludeIds-if-at-most-1,000)` with `fields: 'id'`; insert each page `ON CONFLICT DO NOTHING`, skipping ids present in staging.
  3. `includes`: one `INSERT ... SELECT` from `audience_ids` (`list = 'include'`) minus staging, `ON CONFLICT DO NOTHING`.
  4. `snapshot_copy` (campaign from a snapshot audience, replaces 1 to 3): one `INSERT ... SELECT` from `audience_snapshot_ids` at that version.
  5. Campaign targets write `campaign_recipients` rows `pending`, except ids that a `sent` or `uncertain` row of another campaign of the same project with the same `campaign_key` already holds, which are written `skipped` with reason `already_received` (only when `skipPrevious`). Snapshot targets write `audience_snapshot_ids` at `snapshotVersion` and fail with `SourceProtocolError('snapshot_too_large')` above `MAX_SNAPSHOT_IDS`.
  6. Each page's inserts and `saveProgress` run in one transaction, so a crash either keeps both or neither. On `'done'` the staging rows for `job_id` are deleted in the same transaction.
  7. Page validation: every id must pass `zIdentifier`, and a `nextCursor` equal to the request cursor is a `SourceProtocolError('cursor_not_advancing')`. Duplicate ids inside or across pages are absorbed by the primary key.

- [ ] **Step 1: Write the failing tests** (fake source, real test Postgres; the job's `saveProgress` writes to a scratch row the test controls): `filter plus includes minus excludes equals the expected set` (fixture: 3,000 matching, 50 includes of which 10 also match and 5 are excluded, 30 excluded matches); `an exclude filter removes its matches, including hand-picked ids` (exclusion wins); `40 excludes are sent as id not_in, 1,500 are subtracted in Postgres` (assert on `calls`); `a hand-picked id the source does not know is still a pending recipient`; `skipPrevious writes already_received for ids sent or uncertain in an earlier campaign with the same key, and pending for ids skipped there`; `a crash in saveProgress after page 2 rolls that page back; a rerun from the saved progress yields the exact set with no duplicates`; `two runMaterialization calls on the same job at once, each with its own claim token, produce the exact set and the loser gets lost_claim`; `the source going down after page 1 propagates SourceUnavailableError and leaves page 1 committed; a rerun completes`; `a page with an id repeated from the previous page is absorbed`; `a 257-character id and a non-advancing cursor are SourceProtocolErrors`; `shouldStop true between pages returns stopped`; `a snapshot target over MAX_SNAPSHOT_IDS fails and writes nothing at the new version`; `no table contains the fake members' displayName or contact values afterwards`.
- [ ] **Step 2: Run** `bun test src/audience/materialize.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `materialize.ts` (bulk inserts through `unnest($n::text[])`).
- [ ] **Step 4: Run** them (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): resumable ids-only audience materialiser`.

---

### Task 7: Audience store and snapshot on save

**Files:**
- Create: `packages/marketing/src/audience/store.ts`, `src/audience/store.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6.
- Produces:
  - `interface AudienceRow { id: string; projectId: string; name: string; mode: 'dynamic' | 'snapshot'; filter: FilterTree | null; excludeFilter: FilterTree | null; includeCount: number; excludeCount: number; version: number; snapshotVersion: number | null; snapshotCount: number | null; snapshotAt: string | null; schemaCheckedAt: string | null; inUse: boolean; createdBy: string; createdAt: string; updatedAt: string }`.
  - `createAudienceStore(deps: { sql: Sql; source: (projectId: string) => Promise<AudienceSource | null>; now: () => Date })` returning `create(ctx: {projectId; userId}, input): Promise<AudienceRow>`, `update(ctx, id, input, expectedVersion: number): Promise<AudienceRow>`, `changeIds(ctx, id, change: z.infer<typeof zIdListChange>, expectedVersion: number): Promise<AudienceRow>`, `listIds(ctx, id, list, cursor: string | null, limit: number): Promise<{ ids: string[]; nextCursor: string | null }>`, `get(ctx, id): Promise<AudienceRow>`, `list(ctx): Promise<AudienceRow[]>`, `remove(ctx, id): Promise<void>`, `freeze(ctx, id): Promise<AudienceRow>`, `definition(ctx, id): Promise<AudienceDefinition & { excludeCount: number }>`.
  - Errors (an `HttpError` from `src/api/http.ts`): `404 not_found`; `409 version_conflict`; `409 audience_in_use` (a campaign in `scheduled`, `running` or `paused` references it; applies to `update`, `changeIds`, `remove`, `freeze`); `400 ids_limit` (a list would exceed 20,000); `400 invalid_filter` with the validation errors; `409 source_not_http` (no http source); `503 source_unavailable` for a freeze when the API is down or busy; `409 source_auth_failed` for a freeze answered with 401 or 403.
  - Rules: `create` and `update` validate against the live schema when `source.schema()` answers within the call, else structurally (`checkAudienceInput(..., null)`) with `schema_checked_at` left null; neither ever needs the API to succeed (spec: the count never blocks saving). Every write bumps `version`. `freeze` (the save action of a snapshot audience) materialises the full audience through `runMaterialization` with a snapshot target at `snapshot_version = version`, then in one transaction sets `snapshot_version`, `snapshot_count`, `snapshot_at` and deletes older snapshot rows; on any source error nothing changes and the error is returned. `freeze` on a dynamic audience is `409 not_snapshot`.

- [ ] **Step 1: Write the failing tests**: `a dynamic audience saves while the source is down and has schema_checked_at null`; `an undeclared dimension is rejected when the source is up`; `adding 20,000 includes in ten chunks of 2,000 succeeds and one more id fails with ids_limit, leaving 20,000`; `remove and clear change the count and bump the version`; `a stale expectedVersion is version_conflict`; `freeze stores the exact materialised set and snapshot_count`; `freeze while the source is down returns source_unavailable and keeps the previous snapshot`; `freeze after an edit replaces the old snapshot rows`; `update, changeIds, freeze and remove on an audience used by a scheduled campaign are audience_in_use`; `the same audience used only by a completed campaign can be edited`; `a project without an http source gets source_not_http on freeze`; `another project's audience is not_found`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `store.ts`; take `SELECT ... FOR UPDATE` on the audience row in each write so the 20,000 check and the in-use check cannot race a concurrent change or campaign start.
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): saved audiences with frozen snapshots`.

---

### Task 8: Campaign state machine and schedule time

**Files:**
- Create: `packages/marketing/src/campaign/state.ts`, `src/campaign/state.test.ts`, `src/campaign/schedule-time.ts`, `src/campaign/schedule-time.test.ts`
- Modify: `src/api/routes-dashboard.ts` (export the existing `isTimeZone`)

**Interfaces:**
- Produces in `state.ts`: `CAMPAIGN_STATES` (`as const`, the eight states), `type CampaignState`; `type CampaignAction = 'schedule' | 'unschedule' | 'start' | 'claim_due' | 'miss' | 'pause' | 'resume' | 'cancel' | 'complete' | 'fail'`; `TERMINAL_STATES = ['completed','cancelled','failed','missed']`; `nextState(state: CampaignState, action: CampaignAction): CampaignState | null` with exactly this table (everything else null): draft: schedule → scheduled, start → running; scheduled: unschedule → draft, start → running, claim_due → running, miss → missed, cancel → cancelled; running: pause → paused, cancel → cancelled, complete → completed, fail → failed; paused: resume → running, cancel → cancelled, fail → failed. `fromStates(action: CampaignAction): CampaignState[]` (for fenced `UPDATE ... WHERE state = ANY($n)`).
- Produces in `schedule-time.ts`: `zonedTimeToUtc(local: string, timeZone: string): Date | null` for `YYYY-MM-DDTHH:mm`; null for a malformed string, an unknown zone, or a local time that does not exist (DST gap). Approach: take the UTC instant of the same wall time as a guess, read the zone's offset at the guess through `Intl.DateTimeFormat(...).formatToParts`, subtract it, re-read the offset at the result and correct once, then format the result back in the zone and return null unless it equals `local`. `isTimeZone` is exported from `src/api/routes-dashboard.ts` (currently file-local) and reused.

- [ ] **Step 1: Write the failing tests**: state: `the table above exactly` (iterate all 8 × 10 pairs against an expected map); `terminal states accept no action`; property test with a seeded PRNG (no new dependency), 10,000 random action sequences of length 1 to 20 from draft: every reached state is in `CAMPAIGN_STATES`, a terminal state is never left, `running` is only entered by start, claim_due or resume, and every non-draft state is reached at least once overall. Schedule time: `2026-11-10T09:00 in Asia/Kolkata is 03:30Z`; `America/New_York 2026-03-08T02:30 (DST gap) is null`; `America/New_York 2026-11-01T01:30 (ambiguous) resolves to one of the two instants and round-trips`; `an unknown zone is null`; `2026-02-30T10:00 is null`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): campaign state machine and timezone-aware send times`.

---

### Task 9: Campaign service and safety gates

**Files:**
- Create: `packages/marketing/src/campaign/service.ts`, `src/campaign/service.test.ts`, `src/campaign/definition.ts`
- Modify: `src/config.ts` and `src/config.test.ts` (`confirmThreshold`)

**Interfaces:**
- Consumes: Tasks 1, 5, 7, 8; `zStep.shape.template` (push, email, webhook templates have the journey shape `{subject?, body}`); `HH_MM`, `Caps`.
- Produces in `config.ts`: `MarketingConfig.confirmThreshold: number` from `MARKETING_CONFIRM_THRESHOLD` (positive integer, default 5000).
- Produces in `definition.ts`: `zCampaignDraft = z.strictObject({ name, channel, template, audienceId?, campaignKey? (max 100), skipPreviousRecipients?, sendAtLocal? ('YYYY-MM-DDTHH:mm'), timezone? (default 'Asia/Kolkata'), ifLateMinutes? (0..1440, default 60), quietHoursOverride? ({enabled: boolean; start?: HH_MM; end?: HH_MM; timezone?} | null), frequencyCap? ({max: 1..10,000; periodSeconds: 60..31,536,000} | null) })`; template by channel: push, email, webhook use the journey template shape; sms and whatsapp `{ templateId: string }` (resolved against the registry in plan 2). A partial `zCampaignPatch` for drafts.
- Produces in `service.ts`:
  - `interface CampaignRow` (camelCase of every `campaigns` column plus `counters: { queued; sent; failed; skipped; uncertain }`).
  - `createCampaignService(deps: { sql: Sql; cfg: MarketingConfig; audiences: ReturnType<typeof createAudienceStore>; source: (projectId: string) => Promise<AudienceSource | null>; now: () => Date; channelReady?: (projectId: string, channel: string, template: unknown) => Promise<string | null> })` returning `create(ctx, draft): Promise<CampaignRow>` (state draft, `confirm_threshold = cfg.confirmThreshold`, never client-set), `update(ctx, id, patch, expectedVersion)` (drafts only, else `409 not_draft`), `get`, `list`, `remove(ctx, id)` (drafts only), `countPreview(ctx, id): Promise<AudienceCount>`, `start(ctx, id, body: { confirm?: { count: number; channel: string } })`, `schedule(ctx, id, body: { confirm?: ... })`, `unschedule`, `pause`, `resume`, `cancel`, `requestTestSend(ctx, id, profileId: string): Promise<{ id: string }>`, and for plan 2 `completeIfDone(campaignId: string): Promise<boolean>` and `failCampaign(campaignId: string, reason: string): Promise<void>`.
  - Gates for `start` and `schedule`, in order, each a `409` with the code named: `missing_audience`; `audience_snapshot_stale` (snapshot mode and `snapshot_version` differs from `version`, or never frozen); `invalid_filter` (live schema check fails; `source_unavailable` 503 if the schema cannot be read); `channel_not_ready` (the `channelReady` hook's code; the default returns null for push, email and webhook and `channel_not_ready` for sms and whatsapp until plan 2 supplies the registry check); `count_preview_required` (no preview, or its `campaignVersion`/`audienceVersion` differ from the current ones, or it is older than 15 minutes); `confirmation_required` (preview count above `confirm_threshold` and `confirm` missing, answered with `{count, channel}`) and `confirmation_mismatch` (`confirm` differs from the preview's count or the campaign's channel). `schedule` also needs `sendAtLocal` and converts it with `zonedTimeToUtc` (`400 invalid_send_time` when null, `409 schedule_in_past` when before now) and sets `send_kind = 'scheduled'`.
  - `start` when the project already has a running or paused campaign moves the campaign to `scheduled` with `send_kind = 'now'` and `send_at = now` (queued; Task 10 starts it when the slot frees); otherwise to `running` with `started_at` and `audience_version` set, `materialize_state = 'not_started'`, and a `campaign_counters` row.
  - Every transition is one fenced `UPDATE ... WHERE id = $1 AND project_id = $2 AND state = ANY(fromStates(action))`; zero rows is `409 invalid_transition`. A unique violation on `campaigns_one_active_per_project` during `start` or `resume` is turned into the queued path for `start` and `409 another_campaign_active` for `resume`.
  - `cancel` sets `cancelled` and, in the same transaction, marks the campaign's `pending` and `leased` recipients `skipped` with reason `cancelled` (rows in `sending` are left to the dispatcher) and adds them to `counters.skipped`.
  - `requestTestSend` validates `profileId` with `zIdentifier`, allows at most 10 per campaign per hour (`429 test_send_limit`), and inserts a `campaign_test_sends` row `pending` (plan 2 delivers it). A test send is optional for starting.
  - `completeIfDone` moves `running` to `completed` with `finished_at` when `materialize_state = 'done'` and no recipient is `pending`, `leased` or `sending`.

- [ ] **Step 1: Write the failing tests** (fake source, test Postgres): `create ignores a client-sent confirm_threshold`; `updating a scheduled campaign is not_draft`; `start without a preview is count_preview_required`; `start after editing the campaign or the audience since the preview is count_preview_required`; `a preview of 5,000 starts without confirm`; `a preview of 5,001 needs confirm {5001, push}; a wrong count or channel is confirmation_mismatch`; `sms start is channel_not_ready by default`; `a snapshot audience edited after freeze is audience_snapshot_stale`; `start while another campaign of the project runs queues it as scheduled with send_kind now`; `pause then resume returns to running; resume while another is active is another_campaign_active`; `cancel marks pending and leased recipients skipped with reason cancelled and leaves sending rows`; `cancel on completed is invalid_transition`; `schedule 2026-11-10T09:00 Asia/Kolkata stores send_at 03:30Z`; `schedule in the past is schedule_in_past`; `the 11th test send in an hour is test_send_limit`; `completeIfDone completes only when nothing is pending, leased or sending`; config: `MARKETING_CONFIRM_THRESHOLD defaults to 5000 and rejects 0`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `definition.ts`, `service.ts` and the config value.
- [ ] **Step 4: Run** them (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): campaigns with count preview, confirmation and test-send requests` (body: new optional env `MARKETING_CONFIRM_THRESHOLD`, default 5000).

---

### Task 10: Schedule claimer and materialise runner

**Files:**
- Create: `packages/marketing/src/campaign/scheduler.ts`, `src/campaign/scheduler.test.ts`, `src/campaign/materialize-runner.ts`, `src/campaign/materialize-runner.test.ts`
- Modify: `src/worker.ts` (two `every` jobs at `cfg.tickMs`)

**Interfaces:**
- Consumes: Tasks 4, 6, 8, 9; `SourceResolver.forProject`; error classes.
- Produces:
  - `runScheduleTick(deps: { sql: Sql; now: () => Date; batch?: number }): Promise<{ started: number; missed: number }>`: claims due `scheduled` campaigns (`send_at <= now`, ordered by `send_at`, `FOR UPDATE SKIP LOCKED`, default batch 20). A `send_kind = 'scheduled'` campaign later than `if_late_minutes` is moved to `missed` with `state_reason = 'late'` even when its project is busy; otherwise, if the project has no running or paused campaign, it moves to `running` (as `start` does); if the project is busy it stays scheduled. A unique violation on the one-active index (another replica won the project) leaves it scheduled. A queued `send_kind = 'now'` campaign is never missed.
  - `runMaterializeTick(deps: { sql: Sql; sources: SourceResolver; redis: Redis; cfg: MarketingConfig; now: () => Date }): Promise<{ ran: number }>`: claims one campaign (`state IN ('running','paused')`, `materialize_state IN ('not_started','in_progress')`, retry time due, lease free or expired) with `FOR UPDATE SKIP LOCKED`, sets a fresh `materialize_lease_token` and `materialize_lease_until = now + 60 s`, and runs `runMaterialization` with `withCampaignLane(source)`. `saveProgress` is fenced on the token and also extends the lease; `shouldStop` reads `state = 'cancelled'`. Outcomes: done → `materialize_state = 'done'`, `campaign_counters.queued` = pending rows, `skipped` += already_received rows; `SourceUnavailableError` or `SourceBusyError` → `materialize_retry_at = now + 30 s`, `materialize_error = 'source_unavailable'`, attempts unchanged; `SourceAuthError` → the same with `source_auth_failed` plus `audience_sources.status = 'source_auth_failed'`; `SourceProtocolError` → attempts + 1, retry in 30 s, at 5 attempts `materialize_state = 'failed'` and `failCampaign(id, 'materialize_failed')`; no http source → `materialize_error = 'source_not_http'`, retry in 30 s. The error text written is the code only.

- [ ] **Step 1: Write the failing tests** (fake clock, fake source): scheduler: `a campaign due 59 minutes ago starts`; `a campaign due 61 minutes ago with ifLate 60 is missed with reason late`; `ifLate 0 misses anything not claimed at its minute`; `a queued now campaign starts when the running one completes and is never missed`; `two runScheduleTick calls in parallel start each due campaign once`; `two due campaigns of one project: one running, one still scheduled`. Runner: `materialises 3,000 ids and sets queued 3,000`; `a source down for 60 s (fake clock) leaves the campaign running with source_unavailable, no failed mark, and a later tick completes with the exact set and no duplicates`; `an expired lease is taken over by a second runner and the first runner's next saveProgress returns lost_claim`; `two runners in parallel never materialise the same campaign at once`; `cancel during materialisation stops it`; `five protocol errors fail the campaign with materialize_failed`; `a 401 sets source_auth_failed on the source row`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** both modules and the worker wiring (each job in its own `every`, so a failure in one does not stop the other).
- [ ] **Step 4: Run** the package suite (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): replica-safe campaign schedules and recipient materialisation`.

---

### Task 11: Audience routes

**Files:**
- Create: `packages/marketing/src/api/routes-audiences.ts`, `src/api/routes-audiences.test.ts`
- Modify: `src/api/http.ts` (`RouteContext.userId: string`, empty for non-dashboard routes), `src/api/auth.ts` (`authenticateDashboard` returns `{ projectId: string; userId: string }`), `src/api/server.ts` (pass `userId`, register the routes when `redis` and `sources` exist)

**Interfaces:**
- Consumes: Tasks 5, 7; `SourceResolver`; `parseJsonBody`, `validate`, `json`, `HttpError`.
- Produces (all `auth: 'dashboard'`, under `/marketing/`):
  - `GET audience/schema` → `Schema`; `GET audience/dimensions/:key/values?q=&limit=` (limit 1..100, default 20) → `{values}`; `POST audience/resolve {inputs: string[]}` → `{ids, unmatchedPositions}`.
  - `GET audiences` → `{audiences: AudienceRow[]}`; `POST audiences` → `AudienceRow`; `GET|PUT|DELETE audiences/:id` (`PUT` body `{...zAudienceInput, expectedVersion}`); `GET audiences/:id/ids?list=&cursor=&limit=` (limit 1..1,000); `POST audiences/:id/ids {...zIdListChange, expectedVersion}`; `POST audiences/:id/count` → `AudienceCount`; `POST audiences/:id/preview {cursor?, limit?}`; `POST audiences/:id/explain {id}`; `POST audiences/:id/freeze`.
  - Source errors map to: unavailable or busy `503 source_unavailable`; auth `409 source_auth_failed`; protocol `502 source_error`; no http source `409 source_not_http`.

- [ ] **Step 1: Write the failing tests** (through `createServer` like `routes.test.ts`, fake source injected via a resolver stub): `every route needs the proxy secret`; `create, update, add 20,000 ids in 2,000-id chunks, count, preview, explain and freeze round-trip`; `a 2,001-id chunk is 400 invalid_body`; `a 1 MiB-plus body is 413`; `resolve with a pasted phone returns its id; the response, any error and captured console output contain none of the inputs` (also for 201 inputs and for a source that throws); `count while the source is down is 503 source_unavailable and saving still works`; `a stored-source project gets 409 source_not_http on count and freeze`; `audience/dimensions with a key containing a quote is signed correctly` (Phase 1 ruling); `project A cannot read project B's audience`; `created_by is the forwarded user id`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement**; update existing callers of `authenticateDashboard` and their tests for the new return type.
- [ ] **Step 4: Run** the package suite (PASS).
- [ ] **Step 5: Commit** `feat(marketing): audience builder and saved-audience API`.

---

### Task 12: Campaign routes

**Files:**
- Create: `packages/marketing/src/api/routes-campaigns.ts`, `src/api/routes-campaigns.test.ts`
- Modify: `src/api/server.ts` (register)

**Interfaces:**
- Consumes: Task 9 service; Task 11 `RouteContext.userId` and error mapping (export it from `routes-audiences.ts` as `sourceErrorToHttp(error: unknown): HttpError | null`).
- Produces (`auth: 'dashboard'`, under `/marketing/`): `GET campaigns` → `{campaigns: CampaignRow[]}`; `POST campaigns` → `CampaignRow`; `GET|PATCH|DELETE campaigns/:id` (`PATCH` body `{...zCampaignPatch, expectedVersion}`); `POST campaigns/:id/count-preview` → `AudienceCount`; `POST campaigns/:id/start {confirm?}`; `POST campaigns/:id/schedule {confirm?}`; `POST campaigns/:id/unschedule|pause|resume|cancel` (empty body); `POST campaigns/:id/test-send {profileId}` → `{id}`. Each action answers the updated `CampaignRow`. `CampaignRow` exposes counters and `materializeState`, `materializeError`, `stateReason` so the dashboard can show `missed` and source waits.

- [ ] **Step 1: Write the failing tests**: `draft, preview, start round-trip with counters after one materialise tick`; `confirmation_required answers {count, channel}`; `an invalid transition is 409 invalid_transition`; `a body with an unknown field is 400`; `a campaign of another project is 404`; `test-send with a 257-character id is 400`; `a missed campaign reads state missed with stateReason late`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the package suite (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): campaign API with start, schedule, pause and cancel`.

---

### Task 13: Role rules in the dashboard proxy

**Files:**
- Modify: `apps/start/src/components/marketing/proxy.ts` (`ALLOWED_ROUTES`), `apps/start/src/components/marketing/proxy.test.ts`

**Interfaces:**
- Consumes: Tasks 11 and 12 paths (proxy paths are relative to `/marketing-api/`).
- Produces in `ALLOWED_ROUTES` (spec 6.2: owners and admins start or schedule; members draft and preview):
  - member: `GET audience/schema`, `GET audience/dimensions/[^/]+/values`, `POST audience/resolve`, `GET|POST audiences`, `GET|PUT audiences/[^/]+`, `GET|POST audiences/[^/]+/ids`, `POST audiences/[^/]+/(count|preview|explain|freeze)`, `GET|POST campaigns`, `GET|PATCH campaigns/[^/]+`, `POST campaigns/[^/]+/count-preview`.
  - admin: `DELETE audiences/[^/]+`, `DELETE campaigns/[^/]+`, `POST campaigns/[^/]+/(start|schedule|unschedule|pause|resume|cancel|test-send)`.

- [ ] **Step 1: Write the failing tests** in `proxy.test.ts`: `a member may create and edit a draft and preview its count`; `a member gets 403 on start, schedule, pause, cancel and test-send`; `an admin may start`; `a no-access user gets 404 on every new route`; `campaigns/x/unknown-action is 404`; `the proxy never logs a request body` (spy on `console`, call `audience/resolve` with a canary phone).
- [ ] **Step 2: Run** `bunx vitest run` in `apps/start`; expect FAIL.
- [ ] **Step 3: Implement** the table entries.
- [ ] **Step 4: Run** `bunx vitest run` (PASS), root `bun run typecheck`, `check-fork.ts`.
- [ ] **Step 5: Commit** `feat(dashboard): role rules for audience and campaign routes`.

---

### Task 14: Materialise load script and slow-API checks

**Files:**
- Create: `packages/marketing/scripts/load-materialize.ts`, `src/audience/materialize.slow.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 10.
- Produces: `bun scripts/load-materialize.ts [--ids 20000] [--page 1000] [--delay-ms 0]`, refusing a database whose name does not end in `_test` (as `scripts/load.ts` does, `MARKETING_LOAD_ALLOW=1` overrides), creating a campaign under project id prefix `marketing-load-` and removing it at the end. It prints `ids, pages, total ms, source ms, plugin ms (total - source), duplicates, missing` and exits 1 when duplicates or missing are non-zero, or when `--delay-ms 0` and plugin ms is at least 5,000 (spec 6.4 target).

- [ ] **Step 1: Write the failing test** `materialize.slow.test.ts`: with the fake source at 2,000 ms per page through an injected sleep that advances a fake clock, 20,000 ids finish with no timeout, no duplicate and no missing id, and the lease is extended on every page so no second runner takes over.
- [ ] **Step 2: Run** it; expect PASS if Task 10 is right (a failure is a lease or retry bug to fix in source).
- [ ] **Step 3: Write** `load-materialize.ts` on top of `runMaterializeTick` and the fake source.
- [ ] **Step 4: Run** `bun scripts/load-materialize.ts` and `bun scripts/load-materialize.ts --delay-ms 2000` against the test database and paste both outputs into the task report. If plugin time is 5 s or more, record the measured value in the report and in the spec section 6.4 table (spec rule) instead of claiming the target.
- [ ] **Step 5: Commit** `test(marketing): materialise load script for 20,000 recipients`.

---

### Task 15: Personal-data scan, docs and phase checks

**Files:**
- Modify: `packages/marketing/src/engine/pii.test.ts`, `packages/marketing/README.md`, `packages/marketing/docs/GUIDE.md`, `packages/marketing/AGENTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `pii.test.ts` gains a case that creates an audience from fake members carrying the Phase 1 canaries (`pii-canary@example.test`, `919999900001`, display name `Canary Student`), resolves the canary phone and email, previews, explains, freezes, starts a campaign and materialises it, then runs the existing scan (every `marketing` table via `row_to_json`, Redis `marketing:*`, captured console). Docs: audiences (blocks, precedence, caps, snapshot versus dynamic, chunked id edits), campaigns (states, gates, `MARKETING_CONFIRM_THRESHOLD`, `ifLate`, one active campaign per project, queueing), materialiser and lane priority, migrations 0011 and 0012 in the upgrade notes.

- [ ] **Step 1: Write** the PII case; run it; expect PASS (a failure is a leak to fix in source, not in the test).
- [ ] **Step 2: Write** the docs; check every env name, route and table name against the code with `grep`.
- [ ] **Step 3: Final verification**: package suite (`MARKETING_ALLOW_RESET=1`), `bunx vitest run` in `apps/start`, root `bun run typecheck`, `check-fork.ts`, `check-rename.ts`, `npx ultracite fix` on every file this plan touched. Record each output in the report.
- [ ] **Step 4: Commit** `docs(marketing): audiences and campaigns guide`.

---

## Interfaces plan 2 consumes

- Tables `marketing.campaigns` (dispatch only when `state = 'running'` and `materialize_state = 'done'`), `marketing.campaign_recipients` (statuses `pending, leased, sending, sent, uncertain, failed, skipped`; `attempt`, `due_at`, `lease_until`, `idempotency_key`, `provider_ref`, `reason`, `sent_at`; claim index on `(campaign_id, due_at) WHERE status = 'pending'`, lease index on `lease_until`), `marketing.campaign_counters`, `marketing.campaign_test_sends`, campaign columns `channel`, `template`, `quiet_hours_override`, `frequency_cap`, `timezone`.
- `createCampaignService(...).completeIfDone(campaignId)`, `.failCampaign(campaignId, reason)`, the `channelReady` hook, `withCampaignLane(source, opts)`, `nextState`/`fromStates`, `CampaignRow`.

## Self-review notes

- **Spec coverage.** 6.1 blocks 1 to 4 (Tasks 2, 5, 7, 11), precedence (Tasks 5, 6), 20,000 caps and resolve (Tasks 2, 5, 7, 11), dynamic versus snapshot and snapshot-fails-when-down (Task 7), materialise once in chunks with includes and excludes and `already_received` (Task 6), 6.2 states, gates, roles, schedules, `ifLate`, `missed` (Tasks 8, 9, 10, 13), cancel and pause semantics up to dispatch (Task 9), 6.3 one running campaign per project and extras queue (Tasks 1, 9, 10), lane priority on the source cap (Task 4), 6.4 materialise and slow or failing API targets (Tasks 10, 14), section 8 Phase 2 audience items (Tasks 2, 5, 6, 15). Dispatch, lookup, channels, quiet-hours release, frequency ledger, email quota and the browser pass belong to plans 2 and 3.
- **Rulings made by this plan (not in the spec):** id lists are edited in chunks of 2,000 because of the 1 MiB body cap; a snapshot audience is saved by `freeze` after its edits; an audience in use by a scheduled, running or paused campaign cannot be edited; the approximate count is an upper bound; the exclude filter is materialised and subtracted by the plugin because the contract has no negation; the materialiser is the only caller on the campaign lane; operator pause is the `paused` state, a source outage is not (the campaign stays running with `materialize_error`); a running or paused campaign holds the project's slot; a queued start is `scheduled` with `send_kind = 'now'` and is never missed; `missed` is terminal; a test send is optional and admin-only; sms and whatsapp campaigns cannot start until plan 2's registry check; snapshot cap 100,000 ids.
