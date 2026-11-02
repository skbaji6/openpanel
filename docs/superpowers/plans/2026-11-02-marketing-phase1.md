# Marketing Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the journey-nudge plugin to **marketing**, give it an audience-source contract with an HTTP source, a conformance suite and a reference service, and make journeys resolve contacts through the source.

**Architecture:** The existing worker (`packages/nudge`, Bun/TypeScript, own Postgres schema, Redis, kafkajs) is renamed in place. A new `src/audience/` module defines the seven-call contract, signed requests, a resilient HTTP client and a project-level source resolver. The journey ticker gains a batch path that claims due steps without contact joins and fills recipients from `/members/lookup`; the `stored` source keeps today's behaviour. The reference service and the conformance suite prove the contract and are what the owner's `sia-backend` (a separate plan) is later checked against.

**Tech Stack:** Bun, TypeScript, zod, Postgres (plain-SQL migrations, own runner), Redis, kafkajs, TanStack Start dashboard, bun test.

**Spec:** `docs/superpowers/specs/2026-10-28-marketing-platform-design.md` (sections 3, 5.1 to 5.7, 8, 9). Read it first. Phase 1 of the spec; phases 2 to 5 and the `sia-backend` Track B are separate plans.

## Global Constraints

Every task includes these. Values are verbatim from the spec.

- **Fork discipline.** Never modify, rename, move, reformat or delete an existing upstream OpenPanel file. All plugin code is new files. Allowed edits to existing files: the one `<SidebarLink ... href={'/nudge'} ...>` in `apps/start/src/components/sidebar-project-menu.tsx` (becomes `/marketing`), the regenerated `apps/start/src/routeTree.gen.ts`, and `bun.lock`. Anything else: stop and ask. Never run a formatter or codemod over files this plugin did not create. Never import `@openpanel/core` internals or another package's `src/`; do not edit `packages/db`.
- **Repo rules.** Never push, never add remotes, never rewrite history. Never mark a commit breaking. Commit format `<type>(<scope>): <subject>`, scope `marketing`, with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run `npx ultracite fix <files you changed>` and `bun run typecheck` before finishing a task.
- **Personal data.** Student emails, names, phone numbers and device tokens are never persisted in the marketing database, Redis or logs; ids only. Contact fields live in memory for one batch.
- **Contract limits.** Filter depth at most 3. `members` page `limit` at most 1,000. `lookup` at most 500 ids. `resolve` at most 200 inputs. `id` condition with `in`/`not_in` at most 1,000 values. Signature timestamp window 60 seconds. Per-call timeout 10 s (`count` 5 s). `MARKETING_SOURCE_CONCURRENCY` default 4, global across replicas. Retry on 5xx and 429 with jittered exponential backoff honouring `Retry-After`; 401 and 403 are never retried. `MARKETING_LOOKUP_WINDOW_MS` default 2000. `MARKETING_MAX_LATENESS` default 86400 (seconds). Dead-token hashes purged after 90 days.
- **Rename is total.** `nudge` identifiers, paths, env names, schema, Redis keys and headers all become `marketing`. No backward-compatible names. Nothing is deployed, so existing migrations are edited in place.
- **Branch.** Work in the existing worktree `C:\Repos\openpanel\.worktrees\nudge` on branch `feat/nudge-plugin`. Base commit for diff checks: `f019500c`.

## Review Focus

Failure modes the spec implies that no task would otherwise pin. Each has its test in the named task.

1. The API returns a `lookup` body that omits some ids, repeats some, or adds unrequested ones: missing ids become `not_found`, extras are ignored (Task 8).
2. The API answers 200 with HTML or malformed JSON, or an oversized body: a protocol error, never a crash, never a mark of failure on the step (Tasks 8, 11).
3. The API is down or the breaker is open mid-batch: leased steps go back to pending, nothing is marked failed, no attempt is burned (Task 11).
4. A rotated or wrong secret, or clock skew past the 60 s window, makes every call 401: one clear `source_auth_failed` state in the dashboard, no retry storm (Tasks 8, 9).
5. Pasted `resolve` input that is empty, has blank lines, duplicates, or more than 200 entries: rejected or de-duplicated before any call, and its contents are never logged (Tasks 5, 8).

---

### Task 1: Guard scripts (red first)

**Files:**
- Create: `packages/nudge/scripts/check-rename.ts`, `packages/nudge/scripts/check-fork.ts`, `packages/nudge/scripts/check-guards.test.ts`

**Interfaces:**
- Produces: `bun scripts/check-rename.ts` and `bun scripts/check-fork.ts`, each exits 0 on pass and 1 on failure, printing offending paths; exported `findRenameViolations(files: {path: string; text: string}[]): string[]` and `findForkViolations(changes: {status: string; path: string}[]): string[]` for tests.

Behaviour. `check-rename`: scans the files added or modified on this branch since `f019500c` (`git diff --name-only f019500c` plus untracked files), skips `docs/superpowers/**` and any path where git shows the file existed at the base (upstream files that contain the English word, such as `apps/public/content/articles/cohort-analysis.mdx`), and flags any case-insensitive `nudge` in a path or in text. `check-fork`: runs `git diff --name-status f019500c` plus untracked files; every entry must be `A`, except `M` for exactly `apps/start/src/components/sidebar-project-menu.tsx`, `apps/start/src/routeTree.gen.ts` and `bun.lock`.

- [ ] **Step 1: Write the failing tests** in `check-guards.test.ts`: `findRenameViolations` flags `src/x.ts` containing `NUDGE_PORT`, flags a path `nudge/foo.ts`, ignores text under `docs/superpowers/`; `findForkViolations` accepts `A packages/marketing/a.ts`, accepts `M bun.lock`, rejects `M apps/start/package.json`, rejects `D apps/api/src/x.ts`, rejects `R` entries.
- [ ] **Step 2: Run** `bun test packages/nudge/scripts/check-guards.test.ts`. Expected: FAIL (functions not defined).
- [ ] **Step 3: Implement** both scripts and the two exported functions; the CLI wrappers gather git output with `Bun.spawn`.
- [ ] **Step 4: Run** the tests (PASS), then `bun packages/nudge/scripts/check-fork.ts` (PASS) and `bun packages/nudge/scripts/check-rename.ts` (FAIL, listing the files the next tasks rename: this is the red state).
- [ ] **Step 5: Commit** `test(marketing): guard scripts for the rename and fork discipline`.

---

### Task 2: Rename the backend package

**Files:**
- Move: `packages/nudge` to `packages/marketing` (`git mv`), `docker-compose.nudge.yml` to `docker-compose.marketing.yml`, `.github/workflows/nudge.yml` to `.github/workflows/marketing.yml`
- Modify (inside the moved files): every `nudge`/`NUDGE`/`Nudge` identifier, string, SQL schema reference, env name, header name, Redis key, route, compose service and CI path per the table below; `bun.lock` via `bun install`

**Interfaces:**
- Produces: package `@openpanel/marketing`; type `MarketingConfig` (was `NudgeConfig`); `resetMarketingTables()` (was `resetNudgeTables`); SQL schema `marketing`; env prefix `MARKETING_` (including `MARKETING_ALLOW_RESET`, `MARKETING_PROXY_SECRET`, `MARKETING_PUBLIC_URL`, `MARKETING_KAFKA_GROUP` default `marketing`); HTTP prefixes `/marketing/*`; request headers `x-marketing-proxy-secret`, `x-marketing-project-id`, `x-marketing-user-id`, `x-marketing-csrf`, `x-marketing-api-key`; Redis keys `marketing:*`; compose service `op-marketing`; log prefixes `marketing ticker:` and `marketing api:`.

- [ ] **Step 1: Run** `bun packages/nudge/scripts/check-rename.ts` and record the failing count (this is the starting red state).
- [ ] **Step 2: Move and rewrite.** `git mv` the three paths; apply the identifier table with a throw-away script kept outside the repo (scratchpad), then review the diff by eye. Edit migrations 0001 to 0006 in place (`CREATE SCHEMA marketing`, all `nudge.` references). Reword user-facing prose that says "nudge" to "journey message" or "marketing".
- [ ] **Step 3: Update the test that pins the name.** In `src/db/migrate.test.ts` assert that `migrate()` creates schema `marketing` and records migrations in `marketing.schema_migrations`.
- [ ] **Step 4: Refresh the lockfile** with `bun install`; confirm only `bun.lock` and the new package paths changed outside the moved files.
- [ ] **Step 5: Run** `bun run typecheck` and, in `packages/marketing`, `bun test --isolate` using the test environment described in `packages/marketing/AGENTS.md` (a `_test` database, Redis). Expected: all package tests pass (301 before the rename).
- [ ] **Step 6: Run** `bun packages/marketing/scripts/check-fork.ts` (PASS). `check-rename` still fails only on the dashboard files (Task 3).
- [ ] **Step 7: Commit** `refactor(marketing): rename the nudge package, schema, env and routes to marketing` (use separate `git mv` and rewrite commits if the diff is unreadable).

Task 2 and Task 3 land together: the dashboard still sends the old headers until Task 3, so do not run the browser e2e between them.

---

### Task 3: Rename the dashboard

**Files:**
- Move: `apps/start/src/components/nudge/` to `.../marketing/`; routes `apps/start/src/routes/_app.$organizationId.$projectId.nudge._tabs*.tsx` to `...marketing._tabs*.tsx`, `nudge-api.$.tsx` to `marketing-api.$.tsx`, `nudge.unsubscribe.tsx` to `marketing.unsubscribe.tsx`
- Modify: moved files; `apps/start/src/components/sidebar-project-menu.tsx` (the one existing file, allowed); `apps/start/src/routeTree.gen.ts` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: Task 2's header names and `/marketing/*` paths.
- Produces: route `/$organizationId/$projectId/marketing/...`; proxy path `/marketing-api/*`; public route `/marketing/unsubscribe`; env `MARKETING_URL`, `MARKETING_PROXY_SECRET` read by the proxy; sidebar link `href={'/marketing'}` with label "Marketing"; tabs Journeys (the rules page, route index), Channels, Results, How it works (Campaigns and Audiences come in phase 2).

- [ ] **Step 1: Update the tests first**: in `proxy.test.ts` and `unsubscribe-proxy.test.ts` change expected paths and headers to the new names; in `contract.test.ts` nothing to change unless names appear. Run `bunx vitest run` in `apps/start`. Expected: FAIL.
- [ ] **Step 2: Move and rewrite** the files; rename components (`NudgeProxy` and similar) consistently; tabs and page title text become Marketing and Journeys.
- [ ] **Step 3: Edit the sidebar link** only on its existing lines (href and label).
- [ ] **Step 4: Regenerate** `routeTree.gen.ts` with the repo's route generation (a running dev server regenerates it); do not hand-edit it. Update `apps/start/.env.local` (untracked) to the new env names.
- [ ] **Step 5: Run** `bunx vitest run` (PASS), `bun run typecheck`, then `bun packages/marketing/scripts/check-rename.ts` and `check-fork.ts` (both PASS; `git diff --name-status f019500c` shows exactly three `M` lines).
- [ ] **Step 6: Browser pass** (local stack from the earlier verification: Postgres, Redis, Redpanda, ClickHouse, API, worker, dashboard): log in with the seeded login, open Marketing, check the four tabs render and Journeys lists a rule created through the proxy. Take a screenshot.
- [ ] **Step 7: Commit** `refactor(dashboard): rename the nudge UI to marketing`.

---

### Task 4: `MARKETING_DATABASE_URL`

**Files:**
- Modify: `packages/marketing/src/config.ts`, `src/db/client.ts`, `src/db/migrate.ts` only if it imports the client differently
- Test: `src/config.test.ts`, `src/db/client.test.ts` (new)

**Interfaces:**
- Produces: `MarketingConfig.databaseUrl: string` (value of `MARKETING_DATABASE_URL`, else `DATABASE_URL`); `sql` exported from `src/db/client.ts` is a client bound to that URL, which is the shared `@openpanel/db` client when the URL equals `DATABASE_URL` and a separate Prisma client otherwise. Pool size still `MARKETING_DB_POOL`.

- [ ] **Step 1: Write failing tests**: `config.test.ts` "uses MARKETING_DATABASE_URL when set", "falls back to DATABASE_URL", "fails when neither is set". `client.test.ts`: with a second test database `<name>_test2` created in the test setup, a `sql` built from that URL runs `SELECT current_database()` and returns the second name.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `databaseUrl` in `loadConfig` and a `createSql(url: string)` in `client.ts` using the Prisma client class that `@openpanel/db` already exports (constructed with `datasourceUrl`); `export const sql` picks the shared client when no separate URL is configured. Do not edit `packages/db`.
- [ ] **Step 4: Run** the full package tests twice: once with only `DATABASE_URL`, once with `MARKETING_DATABASE_URL` pointing at a different `_test` database. Expected: both pass.
- [ ] **Step 5: Commit** `feat(marketing): run on a dedicated database via MARKETING_DATABASE_URL`.

---

### Task 5: Audience contract types and filter validation

**Files:**
- Create: `packages/marketing/src/audience/contract.ts`, `src/audience/filter.ts`, tests `src/audience/filter.test.ts`

**Interfaces:**
- Produces in `contract.ts`: constants `MAX_FILTER_DEPTH = 3`, `MAX_PAGE_SIZE = 1000`, `MAX_LOOKUP_IDS = 500`, `MAX_RESOLVE_INPUTS = 200`, `MAX_ID_CONDITION_VALUES = 1000`; zod schemas and inferred types `FilterTree`, `Condition`, `Op` (`eq|in|not_in|gt|lt|between|exists`), `Dimension` (`key,label,type,multiValued,valuesListable`), `Schema`, `LookupChannel` (`push|whatsapp|sms|email|none`), `LookupEntry` (`{id; status: 'ok'|'not_found'|'suppressed'|'unreachable'; reason?: string; email?: string; phone?: string; devices?: {token: string; platform: string}[]; traits?: Record<string,string|number|boolean>; consent?: {whatsapp?: boolean; sms_promotional?: boolean}}`), `Member` (`{id: string; displayName?: string}`), `Explanation` (`{id; matches: boolean; conditions: {dimension; op; matched: boolean}[]}`).
- Produces in `filter.ts`: `validateFilter(filter: unknown, schema: Schema): {ok: true; filter: FilterTree} | {ok: false; errors: string[]}`; `normalizeResolveInputs(raw: string[]): {inputs: string[]; errors: string[]}` (trims, drops blanks, de-duplicates, errors above 200, never echoes the values).

- [ ] **Step 1: Write failing tests**: `rejects depth 4`; `accepts depth 3`; `rejects a dimension the schema does not declare`; `allows the reserved id dimension only with in and not_in`; `rejects an id condition with 1001 values`; `between needs exactly two values`; `exists takes no values`; `rejects a string value for a number dimension`; `normalizeResolveInputs removes blanks and duplicates`; `normalizeResolveInputs rejects 201 inputs and the error text contains none of them`.
- [ ] **Step 2: Run** `bun test src/audience/filter.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** both files; the filter schema is recursive (`z.lazy`) with depth checked by a walk.
- [ ] **Step 4: Run** the tests (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): audience contract types and filter validation`.

---

### Task 6: Signed requests

**Files:**
- Create: `packages/marketing/src/audience/signing.ts`, `src/audience/signing.test.ts`

**Interfaces:**
- Produces: `SIGNATURE_WINDOW_SECONDS = 60`; `signRequest(input: {method: string; path: string; body: string; keyId: string; secret: string; timestamp: number; nonce: string}): Record<string,string>` returning `Authorization: Bearer <keyId>.<secret>`, `X-Timestamp`, `X-Nonce`, `X-Signature` (hex HMAC-SHA256 of `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256hex(body)}` keyed by the secret); `verifyRequest(input: {headers: Headers | Record<string,string>; method: string; path: string; body: string; keys: {id: string; secret: string}[]; now: number; nonces: {seenBefore(nonce: string, ttlSeconds: number): Promise<boolean>}}): Promise<{ok: true; keyId: string} | {ok: false; reason: 'missing'|'unknown_key'|'bad_signature'|'stale'|'replayed'}>`; `newNonce(): string`.

- [ ] **Step 1: Write failing tests**: `a signed request verifies`; `a tampered body fails with bad_signature`; `a different path fails`; `a timestamp 61 seconds old is stale and 59 seconds old passes`; `a repeated nonce is replayed`; `either of two configured keys verifies`; `an unknown key id is unknown_key`; `verification compares signatures in constant time` (uses `timingSafeEqual`; assert by calling with equal-length wrong signature, expecting bad_signature, not a throw).
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** with `node:crypto` (`createHmac`, `createHash`, `timingSafeEqual`).
- [ ] **Step 4: Run** the tests (PASS); **Step 5: Commit** `feat(marketing): signed requests for the audience API`.

---

### Task 7: Source limiter and circuit breaker

**Files:**
- Create: `packages/marketing/src/audience/limiter.ts`, `src/audience/breaker.ts`, tests `limiter.test.ts`, `breaker.test.ts`

**Interfaces:**
- Produces: `createSourceLimiter(redis: Redis, opts: {key: string; cap: number; slotTtlMs: number; now?: () => number}): {acquire(): Promise<() => Promise<void>>}`, a global counting semaphore over a Redis sorted set with expiring slots (one Lua script removes expired slots, adds a slot if fewer than `cap`, else the caller polls with a short sleep); `class SourceUnavailableError extends Error` in `src/audience/errors.ts` (also holds `SourceAuthError` and `SourceProtocolError`, both extending `Error`); `createBreaker(opts: {failureThreshold: number; openMs: number; now?: () => number}): {run<T>(fn: () => Promise<T>): Promise<T>}` that opens after `failureThreshold` (5) consecutive `SourceUnavailableError`s, throws `SourceUnavailableError('breaker_open')` while open, allows one probe after `openMs` (30,000), and does not count `SourceAuthError` or `SourceProtocolError`.

- [ ] **Step 1: Write failing tests** against the real test Redis: `two replicas never exceed the cap` (cap 2, five concurrent acquirers, record max in flight), `a crashed holder's slot expires after slotTtlMs`, `release frees a slot`; breaker with a fake clock: `opens after five failures`, `half-opens after 30 seconds and closes on success`, `an auth error does not count`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** both modules. Redis key prefix `marketing:source-sem:`.
- [ ] **Step 4: Run** the tests (PASS); **Step 5: Commit** `feat(marketing): global source concurrency cap and circuit breaker`.

---

### Task 8: HTTP audience source

**Files:**
- Create: `packages/marketing/src/audience/source.ts`, `src/audience/http-source.ts`, `src/audience/http-source.test.ts`

**Interfaces:**
- Consumes: Task 5 types, Task 6 `signRequest`/`newNonce`, Task 7 limiter, breaker, errors.
- Produces in `source.ts`: `interface AudienceSource { schema(): Promise<Schema>; dimensionValues(key: string, q: string, limit: number): Promise<{value: string; label: string}[]>; count(filter: FilterTree): Promise<{count: number; approximate?: boolean}>; members(req: {filter: FilterTree; cursor?: string; limit: number; fields: 'id'|'preview'}): Promise<{members: Member[]; nextCursor: string | null}>; explain(filter: FilterTree, id: string): Promise<Explanation>; lookup(ids: string[], channel: LookupChannel): Promise<LookupEntry[]>; resolve(inputs: string[]): Promise<{matches: {input: string; id: string}[]; unmatched: string[]}> }`.
- Produces in `http-source.ts`: `createHttpSource(opts: {baseUrl: string; keyId: string; secret: string; limiter: ReturnType<typeof createSourceLimiter>; breaker: ReturnType<typeof createBreaker>; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number}): AudienceSource`. Paths: `GET /schema`, `GET /dimensions/{key}/values`, `POST /audience/count`, `POST /audience/members`, `POST /audience/explain`, `POST /members/lookup`, `POST /members/resolve`. Calls are signed, take a limiter slot, run inside the breaker; `count` times out at 5 s, others 10 s; retries (at most 3 attempts) on 5xx, 429 and network errors with jittered exponential backoff (200 ms base, 30 s cap) honouring `Retry-After` in seconds or HTTP date; 401 and 403 throw `SourceAuthError` without retry; bodies over 8 MiB or not valid JSON for the schema throw `SourceProtocolError`; error messages carry the route and status only, never the response body.

- [ ] **Step 1: Write failing tests** with an injected fake `fetch`: `signs every call`; `lookup returns one entry per requested id, synthesising not_found for ids the API omitted`; `lookup ignores ids that were not requested and duplicate entries`; `retries a 503 then succeeds`; `honours Retry-After on a 429 using the injected sleep`; `does not retry a 401 and throws SourceAuthError`; `a 200 with an HTML body is a SourceProtocolError`; `an 8 MiB plus body is a SourceProtocolError`; `count times out after 5 seconds with a fake clock`; `lookup with 501 ids is split into two requests`; `an error message never contains the response body`; `holds a limiter slot only during the call`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.** Validate every response with the Task 5 zod schemas before returning.
- [ ] **Step 4: Run** the tests (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): resilient HTTP audience source client`.

---

### Task 9: Source settings, resolver and API routes

**Files:**
- Create: `packages/marketing/migrations/0007_audience_sources.sql`, `src/audience/resolver.ts`, `src/api/routes-audience-source.ts`, tests `src/audience/resolver.test.ts`, `src/api/audience-source.test.ts`
- Modify: `src/api/server.ts` (register routes), `src/config.ts` (`sourceConcurrency`, `lookupWindowMs`, `maxLatenessSeconds` with the defaults in Global Constraints), `src/worker.ts` (build the resolver and pass it into the ticker deps)

**Interfaces:**
- Produces: table `marketing.audience_sources(project_id text primary key, kind text not null check (kind in ('stored','http')), base_url text, key_id text, secret_encrypted text, updated_at timestamptz not null default now())`; `createSourceResolver(deps: {sql: Queryable; cfg: MarketingConfig; redis: Redis; fetch?: typeof fetch; now?: () => number}): {forProject(projectId: string): Promise<AudienceSource | null>}` (null when the row is missing or `kind = 'stored'`; one limiter key and one breaker per project; cached 30 s; secret decrypted with the helpers the channel configs use); routes `GET /marketing/audience-source` (never returns the secret; returns `{kind, baseUrl, keyId, hasSecret, status}` where `status` is `ok|source_auth_failed|unreachable|unknown`), `PUT /marketing/audience-source` (validates `baseUrl` is `https:` except `localhost`, encrypts the secret, an empty secret keeps the stored one), `POST /marketing/audience-source/test` (calls `schema()`; returns `{ok, dimensions, latencyMs}` or `{ok: false, error: 'source_auth_failed'|'unreachable'|'protocol_error'}`).

- [ ] **Step 1: Write failing tests**: resolver `returns null for stored and for a missing row`, `returns a source for http`, `caches for 30 seconds and refreshes after a PUT`; routes `GET never contains the secret`, `PUT rejects an http:// base URL that is not localhost`, `PUT with an empty secret keeps the old secret`, `test returns source_auth_failed on a 401 from the fake API`, `the stored secret in the database is not the plaintext`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** the migration, resolver and routes; add the three config values and their parsing tests to `config.test.ts`.
- [ ] **Step 4: Run** the package tests (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): per-project audience source settings`.

---

### Task 10: Audience source settings in the dashboard

**Files:**
- Modify: `apps/start/src/components/marketing/proxy.ts` (route table), `proxy.test.ts`, `channels-page.tsx`
- Create: `apps/start/src/components/marketing/audience-source-card.tsx`

**Interfaces:**
- Consumes: Task 9 routes. Proxy rules: `GET audience-source` member; `PUT audience-source` admin; `POST audience-source/test` admin (same role rule as the existing channel settings).
- Produces: `AudienceSourceCard` on the Channels tab: a select (Stored contacts, HTTP API), base URL, key id, a write-only secret field (shows "secret saved" when `hasSecret`), a Test connection button showing the dimension count and latency or the error code in plain words, and a banner when `status` is `source_auth_failed`.

- [ ] **Step 1: Write failing tests** in `proxy.test.ts`: `a member may GET audience-source`, `a member may not PUT or POST test`, `an admin may`; component test with testing-library if the folder already has one, else only the proxy tests.
- [ ] **Step 2: Run** `bunx vitest run` in `apps/start`; expect FAIL.
- [ ] **Step 3: Implement** the proxy rules and the card, following the existing channel cards' markup and `useMarketingFetch` pattern.
- [ ] **Step 4: Browser pass** with the local stack: save a source pointing at a throw-away local fake, press Test, screenshot the success and the `source_auth_failed` banner (wrong secret).
- [ ] **Step 5: Commit** `feat(dashboard): audience source settings`.

---

### Task 11: Journeys resolve contacts through the source

**Files:**
- Modify: `packages/marketing/src/engine/ticker.ts` (claim and send path), `src/worker.ts` (wiring), `src/engine/ticker.test.ts`
- Create: `src/engine/lookup-batch.ts`, `src/engine/lookup-batch.test.ts`, `src/engine/http-source-ticker.test.ts`

**Interfaces:**
- Consumes: Task 8 `AudienceSource`, Task 9 `forProject`.
- Produces: `TickDeps.sources: {forProject(projectId: string): Promise<AudienceSource | null>}`; in `lookup-batch.ts`: `gatherLookupBatch<T extends {projectId: string; profileId: string}>(items: T[], opts: {maxBatch: number; windowMs: number; now: () => number; sleep: (ms: number) => Promise<void>; refill: () => Promise<T[]>}): Promise<T[][]>` which returns groups of at most `maxBatch` (500) ids per project, dispatching at once when a group is full and otherwise after `windowMs` (2000), refilling from newly claimed steps during the wait; a slot in the source limiter is only taken after the window closes. The existing contact-joined `CONTEXT_SQL` stays for the `stored` source; a second `CONTEXT_NO_CONTACT_SQL` (same columns, `email`, `attributes`, `device_tokens` and `opted_out` removed from the select) serves http projects. Lookup `status` maps to skipped outcomes with reasons `not_found`, `suppressed`, `unreachable:<reason>` through the existing skip recording path; a webhook step looks up with channel `none`.

- [ ] **Step 1: Write failing tests**: `lookup-batch`: `dispatches a full group of 500 immediately`, `dispatches a partial group after the window`, `groups by project`, `never exceeds 500`. `http-source-ticker.test.ts` with a fake `AudienceSource` and a capturing channel: `delivers through lookup without reading nudge contacts` (no rows in `marketing.contacts` or `devices`, step is sent with the looked-up email), `skips not_found with reason not_found`, `skips suppressed`, `skips unreachable with its reason`, `a webhook step uses channel none`, `a stored project in the same tick still uses its contact rows`, `when lookup throws SourceUnavailableError the claimed steps return to pending, none is marked failed and the attempt count is not increased`, `SourceAuthError sets the project's source status to source_auth_failed and leaves steps pending`, `one lookup call serves many steps of one project`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.** In `runTick`, after claiming, split claims by `sources.forProject(projectId)`; stored claims follow today's path unchanged; http claims go through `gatherLookupBatch`, one `lookup` per group, then the existing render, gates, deliver and `MARK_SQL` fencing per step with the recipient built from the lookup entry (`traits` become `attributes`). Requeue on source failure reuses `REQUEUE_SQL` semantics with the attempt restored.
- [ ] **Step 4: Run** the whole package suite (all existing tests must still pass) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): journeys resolve contacts through the audience source`.

---

### Task 12: Dead tokens and late steps

**Files:**
- Create: `packages/marketing/migrations/0008_dead_tokens.sql`, `src/engine/dead-tokens.ts`, `src/engine/dead-tokens.test.ts`
- Modify: `src/engine/ticker.ts` (invalid-token handling and expiry), `src/engine/history-purge.test.ts` and the hourly purge it tests

**Interfaces:**
- Produces: table `marketing.dead_tokens(project_id text not null, token_hash bytea not null, seen_at timestamptz not null default now(), primary key (project_id, token_hash))`; `hashToken(secretKey: string, token: string): Buffer` (HMAC-SHA256 keyed from the config's `encryptionKey`); `recordDeadTokens(sql: Queryable, projectId: string, tokens: string[], key: string): Promise<void>`; `filterLiveTokens(sql: Queryable, projectId: string, tokens: string[], key: string): Promise<string[]>`; hourly purge deletes rows older than 90 days. For http projects an invalid token is recorded here instead of deleting `marketing.devices` rows; stored projects keep `pruneInvalidTokens`. Late steps: a claimed step whose `due_at` is older than `now - maxLatenessSeconds` is marked skipped with reason `expired` before any lookup or send, for both sources.

- [ ] **Step 1: Write failing tests**: `recordDeadTokens then filterLiveTokens removes only those tokens`, `the stored hash is not the token and differs per project key`, `purge removes rows older than 90 days and keeps newer`, `an http project's invalid token is hashed, not stored, and not deleted from devices`, `a step later than the max lateness is skipped as expired and is not looked up`, `a step 1 second inside the limit is sent`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** the migration, module, ticker changes and purge addition.
- [ ] **Step 4: Run** the package suite (PASS).
- [ ] **Step 5: Commit** `feat(marketing): hashed dead tokens and expiry for late journey steps`.

---

### Task 13: Reference audience service

**Files:**
- Create: `packages/marketing/examples/audience-api-postgres/{server.ts,compile.ts,mapping.ts,mapping.example.json,seed.sql,README.md}`, tests `compile.test.ts`, `server.test.ts` beside them

**Interfaces:**
- Consumes: Task 5 contract types and `validateFilter`, Task 6 `verifyRequest`.
- Produces: `compileFilter(filter: FilterTree, mapping: Mapping): {sql: string; params: unknown[]}` (parameterised; values are only ever bound, never concatenated; unknown dimensions throw); `type Mapping` (id column, dimensions with `key,label,type,multiValued,column` or an `exists` sub-select for multi-valued ones, contact columns, devices table, suppression column); `createServer(opts: {mapping: Mapping; db: {query(sql: string, params: unknown[]): Promise<{rows: unknown[]}>}; keys: {id: string; secret: string}[]; now?: () => number}): {fetch(req: Request): Promise<Response>}` implementing the seven routes with the signature check of Task 6 (deny by default, 401 on any failure), page cap 1,000, lookup cap 500, keyset cursor on the id column, `count` and `members` over distinct students, and an allow-listed lookup response (never password columns). `seed.sql` creates the demo tables (students, universities, courses, enrollments, devices) in a `reference_demo` schema.

- [ ] **Step 1: Write failing tests**: compile: `eq becomes a bound parameter`, `in with three values binds three params`, `a value containing a quote or semicolon only appears in params`, `not_in`, `between`, `exists`, `nested AND/OR groups keep precedence with parentheses`, `an unknown dimension throws`, `a multi-valued course dimension uses EXISTS and yields one row per student`. Server (against the test Postgres seeded from `seed.sql`): `401 without credentials`, `401 with a stale timestamp`, `401 on a replayed nonce`, `count equals the number of ids paged out`, `keyset paging has no duplicates across pages`, `lookup returns one entry per id and never a password column`, `a page limit of 1001 is rejected with 400`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.** Plain `Bun.serve`-compatible fetch handler; no framework.
- [ ] **Step 4: Run** the tests (PASS). Confirm the worker image excludes `examples/` (check `packages/marketing/Dockerfile` copies only what it needs; add a `.dockerignore` entry if it copies the package wholesale).
- [ ] **Step 5: Commit** `feat(marketing): reference audience API service`.

---

### Task 14: Conformance suite

**Files:**
- Create: `packages/marketing/conformance/{cli.ts,run.ts,checks.ts,seed/dataset.json,seed/seed.sql,seed/expected.json,README.md}`, `conformance/conformance.test.ts`

**Interfaces:**
- Consumes: Task 8 client (the suite drives the target through `createHttpSource`) and Task 6 signing (for raw negative requests).
- Produces: `runConformance(target: {baseUrl: string; keyId: string; secret: string; fetch?: typeof fetch}): Promise<{passed: number; failed: {check: string; detail: string}[]; warnings: {check: string; detail: string}[]}>`; CLI `bun conformance/cli.ts --base-url <url> --key-id <id> --secret <secret>` exiting 1 on any failure. The **seed contract**: `dataset.json` (about 120 students over three universities, four courses, two semesters, a few multi-course students, some suppressed or without phone) and `expected.json` (counts, page sequences, explanations and lookup statuses the target must reproduce); `seed.sql` loads it into a Postgres schema so Track B and the reference service can match it. Checks: schema shape; values paging and search; `count` equals ids paged out; no duplicate ids across pages; multi-course student counted once; explain; lookup one entry per id with the right statuses; resolve returns ids only; limits (1,001 page, 501 ids, 201 inputs) rejected; filter depth 4 rejected; injection strings (quotes, `; DROP`, unicode) in values return 400 or an ordinary result and never a 5xx; a request naming an undeclared dimension rejected; security negatives (no key, wrong key, stale timestamp, replayed nonce) all 401; service-level warnings (count over 2 s, page over 2 s, lookup of 500 over 1 s).

- [ ] **Step 1: Write the failing test** `conformance.test.ts`: start the reference service (Task 13) on the seeded test database and assert `runConformance` returns `failed: []`; a second test points it at a deliberately broken wrapper (drops the signature check; returns 5xx on an injection string) and asserts the named checks fail.
- [ ] **Step 2: Run** it; expect FAIL.
- [ ] **Step 3: Implement** the suite and seed files.
- [ ] **Step 4: Run** the test (PASS). Run the CLI by hand against the reference service and paste the summary into the task report.
- [ ] **Step 5: Commit** `feat(marketing): audience API conformance suite with a seed contract`.

---

### Task 15: End-to-end, personal-data and bandwidth checks

**Files:**
- Create: `packages/marketing/src/engine/pii.test.ts`, `packages/marketing/scripts/consumer-bytes.ts`
- Modify: `packages/marketing/scripts/e2e.ts`

**Interfaces:**
- Produces: `pii.test.ts` runs journeys through a fake source that returns the canaries `pii-canary@example.test`, `919999900001`, `canary-fcm-token-1` and name `Canary Student`, delivers with a capturing channel, then asserts none of the canaries appears in any text column of any `marketing` table (via `row_to_json`), in any Redis key or value under `marketing:*`, or in captured `console` output. `e2e.ts` gains an `http source` scenario: reference service on the seeded Postgres, source configured through the proxy routes, events sent through the API, a webhook receiver confirms one delivery whose body was personalised from lookup traits, and cancellation by the goal still works. `consumer-bytes.ts` reports, for a given run length, events consumed per second and bytes per second of the events topic versus bytes of events the interest filter kept (printed as a table), for the WAN-bandwidth decision in spec section 3.1.

- [ ] **Step 1: Write the failing PII test**; run it; expect FAIL only if a canary leaks (it should PASS once Task 11 is right; if it fails, fix the leak, not the test).
- [ ] **Step 2: Extend `e2e.ts`** and run it against the local stack; expected: all existing checks plus the new scenario pass.
- [ ] **Step 3: Write `consumer-bytes.ts`** and run it for 60 seconds against the seeded stack; record the numbers in the task report.
- [ ] **Step 4: Run** the full package suite, dashboard vitest, root `bun run typecheck`, `check-rename.ts` and `check-fork.ts` (all PASS).
- [ ] **Step 5: Commit** `test(marketing): personal-data canary test, http-source e2e and consumer bandwidth script`.

---

### Task 16: Documentation, contract and cut-over plan

**Files:**
- Modify: `packages/marketing/README.md`, `docs/GUIDE.md`, `AGENTS.md`, `TOUCHPOINTS.md`, `apps/start/src/components/marketing/guide-page.tsx`
- Create: `packages/marketing/docs/AUDIENCE_CONTRACT.md`, `packages/marketing/docs/CUTOVER_BACKEND_JOURNEYS.md`

**Interfaces:**
- Produces: `AUDIENCE_CONTRACT.md` (the seven calls with request and response JSON, filter tree, limits, signing recipe with a worked example, error and status vocabulary, service-level numbers, the conformance suite and how to run it, the personal-data rules, the security rules of spec 5.3 as the adopter's checklist); `CUTOVER_BACKEND_JOURNEYS.md` (the events the backend's `NotificationJourneyService` covers and the plugin rule that replaces each, copy-the-wording step, shadow run to a test list, flag flip, rollback); GUIDE sections for the audience source, the dedicated database and the AWS topology; the in-app guide mentions the source settings.

- [ ] **Step 1: Write** the documents from the spec and the code as built; every env name and path is checked against the code with `grep`.
- [ ] **Step 2: Run** `bun packages/marketing/scripts/check-rename.ts` (PASS; no `nudge` left outside `docs/superpowers`).
- [ ] **Step 3: Final verification**: package suite, dashboard vitest, root typecheck, both guard scripts, `bun packages/marketing/conformance/cli.ts` against the reference service, `git diff --name-status f019500c` shows only `A` plus the three allowed `M`. Record every output.
- [ ] **Step 4: Commit** `docs(marketing): audience contract, cut-over plan and guide updates`.

---

## Self-review notes

- **Spec coverage.** Rename (T1 to T3), topology and dedicated database (T4, T16, T15 bandwidth), contract (T5), secured calls both sides (T6 signing, T13 verification, T14 negatives), resilience (T7, T8), source settings (T9, T10), journeys through the source (T11), dead tokens and expiry (T12), reference service (T13), conformance (T14), PII and e2e (T15), docs and cut-over (T16). The `sia-backend` endpoints are Track B and get their own plan.
- **Known open items for the implementer to confirm, not decide silently:** the exact test environment variables in the package's AGENTS.md, how `@openpanel/db` exposes the Prisma client class (Task 4), and the name of the existing encrypt/decrypt helpers for channel configs (Task 9).
- **Spec deviations made by this plan:** Phase 1 tabs are Journeys, Channels, Results, How it works (Campaigns and Audiences are phase 2); a webhook step looks up with channel `none`; `MARKETING_MAX_LATENESS` is in seconds and applies to both sources. The spec is amended for the first two.
