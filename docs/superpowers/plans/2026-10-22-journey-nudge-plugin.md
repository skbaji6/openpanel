# Journey Nudge Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate `nudge-worker` service plus dashboard module that, per rule ("event A happened, goal G did not within T"), sends a timed sequence of email, webhook or FCM push messages and stops when G is observed.

**Architecture:** A new workspace package `packages/nudge` runs its own Redpanda consumer group (kafkajs, `fromBeginning: false`), stores interest events in Postgres schema `nudge`, creates enrollments and timed steps, and a ticker claims due steps with a lease, applies gates (consumer lag, grace window, goal recheck, caps, quiet hours, opt-outs) and sends through channel adapters. Dashboard UI lives in new files under `apps/start/src/`; a new proxy route authenticates via core's tRPC and calls the worker with a shared secret.

**Tech Stack:** Bun, TypeScript, zod, `kafkajs` 2.2.4, `@openpanel/db` (`db`, Prisma raw SQL), `@openpanel/redis` (`getRedisCache`), `@openpanel/shared/server` (`encryptCredential(key, plaintext)`, `decryptCredential(key, ciphertext)`, `safeFetch`, `hashPassword`, `verifyPassword`), `nodemailer` 8.0.5, `firebase-admin`, TanStack Start/React 19 for the UI.

**Spec:** `docs/superpowers/specs/2026-10-22-journey-nudge-plugin-design.md` (executors read it first; its "Verified facts" section holds the file references this plan relies on).

## Global Constraints

- **Fork discipline (verbatim intent of the spec):** do not modify, rename, move, reformat or delete any existing file. All code is new files: service/migrations/docs/tests under `packages/nudge/`; UI under `apps/start/src/components/nudge/` and new route files under `apps/start/src/routes/`; CI in new `.github/workflows/nudge.yml`; deploy in new `docker-compose.nudge.yml`. Never run formatters or codemods over files you did not create. Never import `@openpanel/core` internals or another package's `src/`.
- **The only allowed edits to existing files** (recorded in `packages/nudge/TOUCHPOINTS.md`): one multi-line `<SidebarLink exact={false} href={'/nudge'} icon={WorkflowIcon} label="Nudges" />` element in `apps/start/src/components/sidebar-project-menu.tsx` (already approved by the user; reuse the already-imported `WorkflowIcon`; do not touch the import block), and regenerated `apps/start/src/routeTree.gen.ts` and `bun.lock`. Any other needed edit: stop and ask the user.
- All plugin source under `packages/nudge/src/`; no files directly in `packages/nudge/` except config files, and none in `apps/start/src/utils/` (conformance gate R21).
- Plugin tables live in Postgres schema `nudge`, never `public`; plain SQL migrations with the plugin's own runner; `schema.prisma` is not touched.
- Nothing in the plugin knows about books, carts or sections; those are admin-chosen event names and properties.
- Defaults (all env-configurable): `NUDGE_GRACE_SECONDS=300`, `NUDGE_MAX_LAG=1000`, `NUDGE_TICK_MS=5000`, `NUDGE_LEASE_SECONDS=120`, `NUDGE_EVENT_RETENTION_DAYS=30`, `NUDGE_PORT=4100`.
- Env read for Kafka: `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`, `KAFKA_EVENTS_TOPIC`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_SASL_MECHANISM`, `KAFKA_SSL`, `KAFKA_SSL_CA_PATH`, `KAFKA_SSL_REJECT_UNAUTHORIZED`; group id `NUDGE_KAFKA_GROUP`. Other env: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `NUDGE_PROXY_SECRET`, `NUDGE_PUBLIC_URL` (for unsubscribe links), `NUDGE_WEBHOOK_ALLOW_HOSTS` (comma list of internal hosts allowed for webhooks).
- Topic message value is `IncomingEventPayload` (`id?`, `projectId`, `event{name, profileId?, properties, timestamp, isTimestampFromThePast}`, `deviceId`, `sessionId`, ...). Events without `event.profileId` are ignored for targeting, goals and activity.
- Event idempotency key: `payload.id`, else `sha256(projectId|deviceId|event.name|event.timestamp|event.profileId)`.
- Tests: `bun test --isolate` inside `packages/nudge`, against the Postgres at `DATABASE_URL` (tests create and truncate only schema `nudge`). Bun 1.4.0 and a local Postgres/Redis are required (`bun run dock:up` from the repo root). Commit steps apply only when the user has asked for commits.
- Test steps below name the test and its key assertions; write them with the spec's exact values.
- **Performance constraints:** the ticker claims at most `NUDGE_CLAIM_BATCH=200` steps per tick and sends with bounded concurrency `NUDGE_SEND_CONCURRENCY=10`; the consumer processes `eachBatch` and writes each batch in one transaction; the worker's Prisma pool is capped by `NUDGE_DB_POOL=10` (the config loader sets `connection_limit` on `DATABASE_URL` before `@openpanel/db` is imported, because the DB is shared with core and `max_connections` is finite); the consumer pre-filter (Task 8) must run before any Postgres call; claim and goal queries must use the indexes from Task 2 (verified by `EXPLAIN` in tests). Acceptance targets (set by the plan author; report measured values against them in Task 12): consumer sustains at least 2,000 events/s per replica when 95% of events are pre-filtered out; the claim query takes under 50 ms with 1,000,000 pending steps.
- **Security constraints:** request bodies are capped at 1 MiB (413); template `body` at most 20,000 characters and `subject` at most 300 (zod); failed API-key attempts and unsubscribe calls are rate limited per client IP (30 per minute, 429); the unsubscribe token HMAC key is derived from `ENCRYPTION_KEY` with HKDF using the info string `nudge-unsubscribe`, never `ENCRYPTION_KEY` itself; secrets (channel config, API keys, proxy secret, webhook secrets, service-account JSON) are never written to logs, errors or API responses (a `redactSecrets` helper is applied to every logged adapter error); every query and API call is scoped by `project_id`.

## Review Focus

- A goal event that reaches the service before its trigger (out of order across partitions): the later-arriving trigger must not enroll/send. Pinned in Task 5.
- The same Kafka message delivered twice (redelivery or DLQ replay): one enrollment, one send. Pinned in Task 5 and Task 6.
- Event or profile property containing HTML or a URL used in a template: output is escaped, and non-allowlisted properties render empty. Pinned in Task 3.
- Recipient who unsubscribed or has no synced email: no email is sent, step is `skipped`, sequence continues. Pinned in Task 6.
- Consumer down or lagging: no step is sent until lag is under `NUDGE_MAX_LAG` and state is fresh (48h Redpanda retention means missed goals are unrecoverable). Pinned in Task 6.

## File Structure

```
packages/nudge/
  package.json  tsconfig.json  bunfig.toml  Dockerfile
  AGENTS.md  TOUCHPOINTS.md  README.md
  migrations/0001_init.sql
  src/config.ts
  src/db/client.ts  src/db/migrate.ts  src/db/test-helpers.ts
  src/rules/rule.schema.ts  src/rules/starter-rules.ts
  src/template/render.ts
  src/events/normalize.ts
  src/engine/engine.ts            # handleEvent: store, enroll, cancel, debounce
  src/engine/ticker.ts            # runTick: claim, gate, send, mark
  src/engine/gates.ts             # caps, quiet hours, opt-out, lag
  src/channels/types.ts  registry.ts  webhook.ts  email.ts  push.ts
  src/kafka/consumer.ts  src/kafka/interest.ts  src/kafka/lag.ts
  src/api/server.ts  src/api/auth.ts  src/api/routes-sync.ts
  src/api/routes-dashboard.ts  src/api/unsubscribe.ts
  src/worker.ts
apps/start/src/components/nudge/{contract.ts,api.ts,rules-page.tsx,rule-editor.tsx,channels-page.tsx,results-page.tsx}
apps/start/src/routes/_app.$organizationId.$projectId.nudge._tabs{,.index,.channels,.results}.tsx
apps/start/src/routes/api/nudge.$.tsx
docker-compose.nudge.yml   .github/workflows/nudge.yml
```

---

### Task 1: Package scaffold, config, guardrail docs

**Files:**
- Create: `packages/nudge/{package.json,tsconfig.json,bunfig.toml,AGENTS.md,TOUCHPOINTS.md,README.md}`, `packages/nudge/src/config.ts`
- Test: `packages/nudge/src/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: Record<string, string | undefined>): NudgeConfig` in `src/config.ts`. `NudgeConfig` has `databaseUrl, redisUrl, encryptionKey, proxySecret, publicUrl, port, graceSeconds, maxLag, tickMs, leaseSeconds, retentionDays, webhookAllowHosts: string[], kafka: { brokers: string[], clientId, topic, groupId, ssl, sasl? }`.

- [ ] **Step 1: Write failing tests** in `config.test.ts`: `defaults apply when only required env is set` (asserts `graceSeconds === 300`, `maxLag === 1000`, `tickMs === 5000`, `leaseSeconds === 120`, `retentionDays === 30`, `port === 4100`, `claimBatch === 200`, `sendConcurrency === 10`, `dbPool === 10`; the returned `databaseUrl` contains `connection_limit=10`); `NUDGE_DB_POOL=3 yields connection_limit=3 and replaces an existing connection_limit param`; `missing KAFKA_EVENTS_TOPIC throws`; `blank KEY= is treated as absent`; `KAFKA_SASL_USERNAME without password throws`; `NUDGE_WEBHOOK_ALLOW_HOSTS "a.internal, b.internal" parses to two hosts`.
- [ ] **Step 2:** Run `bun test --isolate src/config.test.ts` in `packages/nudge`. Expected: FAIL (module missing).
- [ ] **Step 3:** Create `package.json` modelled on `packages/seed/package.json` (name `@openpanel/nudge`, private, type module, scripts `test: bun test --isolate`, `typecheck: tsc --noEmit`, `start: bun src/worker.ts`; dependencies `@openpanel/db`, `@openpanel/redis`, `@openpanel/shared` as `workspace:*`, plus `zod` (catalog), `kafkajs` 2.2.4, `nodemailer` 8.0.5, `firebase-admin`). `tsconfig.json` copies `packages/seed/tsconfig.json`. Implement `loadConfig` with one zod object (blank = absent, cross-field refine before transform).
- [ ] **Step 4:** Write `AGENTS.md` quoting the spec's "Fork discipline" section verbatim plus a pointer to the spec and this plan; `TOUCHPOINTS.md` listing the two allowed touchpoints with status "pending"; `README.md` with env table and adopter notes (compose override must be added by hand to `openpanel init` installs).
- [ ] **Step 5:** Run `bun install` at the repo root (updates `bun.lock`, allowlisted), then `bun test --isolate src/config.test.ts` and `bun run typecheck` in `packages/nudge`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(nudge): scaffold package and config`.

### Task 2: Postgres schema `nudge`, migration runner, test helpers

**Files:**
- Create: `packages/nudge/migrations/0001_init.sql`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/test-helpers.ts`
- Test: `src/db/migrate.test.ts`

**Interfaces:**
- Produces: `sql` (re-export of `db` from `@openpanel/db`) in `client.ts`; `migrate(): Promise<string[]>` returning applied file names (tracks them in `nudge.schema_migrations`); `resetNudgeTables(): Promise<void>` (truncates every table in schema `nudge` except `schema_migrations`).
- Tables (all in schema `nudge`): `rules(id uuid pk, project_id text, name text, status text check in ('active','paused'), definition jsonb, version int, created_at, updated_at)`; `enrollments(id uuid pk, project_id, rule_id uuid, rule_snapshot jsonb, profile_id text, match_value text not null default '', status text check in ('active','completed','cancelled'), trigger_time timestamptz, created_at)` with partial unique index on `(project_id, rule_id, profile_id, match_value) where status='active'`; `steps(enrollment_id uuid, step_index int, due_at timestamptz, status text check in ('pending','sending','sent','skipped','failed','cancelled'), lease_until timestamptz, attempt int default 0, outcome jsonb, sent_at timestamptz, primary key(enrollment_id, step_index))` with partial index on `due_at where status='pending'`; `events(project_id text, event_id text, profile_id text, name text, properties jsonb, event_time timestamptz, primary key(project_id, event_id))` with index `(project_id, profile_id, name, event_time)`; `reference_sets(project_id, set_key, values jsonb, primary key(project_id,set_key))`; `contacts(project_id, profile_id, email text, attributes jsonb, updated_at, primary key(project_id, profile_id))`; `devices(token text primary key, project_id, profile_id, platform text, updated_at)`; `opt_outs(project_id, profile_id, channel, created_at, primary key(project_id, profile_id, channel))`; `channel_configs(project_id, channel, config_encrypted text, primary key(project_id, channel))`; `api_keys(id uuid pk, project_id, key_hash text, label text, created_at)`; `project_settings(project_id pk, caps jsonb, quiet_hours jsonb)`; `consumer_state(id int primary key check (id=1), lag bigint, updated_at timestamptz)`.
- One `events` table covers the spec's goal/activity facts, seen-values and processed-event dedupe (unique `(project_id, event_id)`); a retention job (Task 5) deletes rows older than `retentionDays`.

- [ ] **Step 1: Write failing tests**: `migrate creates schema nudge and every listed table`; `migrate twice applies nothing the second time` (second return is `[]`); `no table was created in schema public by migrate` (query `information_schema.tables` for names `rules, enrollments, steps, events` in `public` returns 0 rows); `partial unique index rejects a second active enrollment for the same (project, rule, profile, match_value) but allows one after the first is completed`; `PERF claim query uses the partial pending-due index` (seed 20,000 pending steps, `SET enable_seqscan=off`, `EXPLAIN` of the Task 6 claim query contains the index name); `PERF events lookup by (project_id, profile_id, name, event_time) uses its index`.
- [ ] **Step 2:** Run `bun test --isolate src/db/migrate.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Write `0001_init.sql` and `migrate.ts` (reads `migrations/*.sql` in name order, each in a transaction, records in `nudge.schema_migrations`; `CREATE SCHEMA IF NOT EXISTS nudge`).
- [ ] **Step 4:** Run the test file. Expected: PASS. Add a `migrate` script (`bun src/db/migrate.ts`) to `package.json`.
- [ ] **Step 5: Commit** `feat(nudge): schema and migration runner`.

### Task 3: Rule model, starter rules, safe template renderer

**Files:**
- Create: `src/rules/rule.schema.ts`, `src/rules/starter-rules.ts`, `src/template/render.ts`
- Test: `src/rules/rule.schema.test.ts`, `src/template/render.test.ts`

**Interfaces:**
- Produces in `rule.schema.ts`: `zRuleDefinition`, `type RuleDefinition`, `zGoal`, `zStep`. Shape: `{ name, trigger: { event: string, filters?: { property: string, equals: string }[] }, matchOn?: string, goal: Goal, steps: Step[] (min 1), reentry: { enabled: boolean, cooldownSeconds: number }, allowedEventProps: string[] }`. `Goal` is a discriminated union on `kind`: `{ kind: 'event', event: string }`, `{ kind: 'set', event: string, property: string, setKey: string }`, `{ kind: 'inactivity', excludeEvents: string[] }`. `Step = { delaySeconds: int >= 0, channel: 'email'|'webhook'|'push', template: { subject?: string, body: string } }` with delays strictly increasing across steps.
- Produces in `starter-rules.ts`: `STARTER_RULES: Record<'cart-abandoned'|'registered-not-bought'|'bought-never-opened'|'opened-sections-untouched', RuleDefinition>` using generic event names (`add_to_cart`, `purchase`, `signup`, `content_opened`, `section_opened`) as editable placeholders.
- Produces in `render.ts`: `renderTemplate(template: string, vars: { profile: Record<string, unknown>, event: Record<string, unknown>, missing: string[], allowedEventProps: string[] }): string`. Variables: `{{profile.<key>}}`, `{{event.<key>}}`, `{{missing}}` (joined with ", "). No code execution; unknown or non-allowlisted `event.*` renders as empty string; every substituted value is HTML-escaped; `{{event.*}}` is never allowed inside `href=` or `src=` attribute values (renders empty there).

- [ ] **Step 1: Write failing tests.** `rule.schema.test.ts`: `accepts each STARTER_RULES entry`; `rejects steps whose delays are not strictly increasing`; `rejects a set goal without setKey`; `rejects zero steps`. `render.test.ts`: `substitutes profile.firstName`; `escapes <script> in event.title into &lt;script&gt;`; `renders empty for event.secret when not in allowedEventProps`; `renders empty for event.url inside href="{{event.url}}" even when allowlisted`; `{{missing}} joins "Chapter 4, Chapter 5"`; `unknown placeholder {{constructor}} renders empty and does not throw`.
- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement with zod and a single-pass regex renderer over `{{ path }}` tokens (no `eval`, no `Function`, own-property lookup only).
- [ ] **Step 4:** Run both test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nudge): rule schema, starter rules, safe template renderer`.

### Task 4: Event normalizer

**Files:**
- Create: `src/events/normalize.ts`
- Test: `src/events/normalize.test.ts`

**Interfaces:**
- Produces: `type NormalizedEvent = { eventId: string, projectId: string, profileId: string, name: string, time: Date, properties: Record<string, string | number | boolean | null> }`; `normalizeEvent(raw: unknown): NormalizedEvent | null` (null when the payload is malformed, has no `event.profileId`, or has no usable timestamp).

- [ ] **Step 1: Write failing tests**: `uses payload.id as eventId when present`; `falls back to sha256 of projectId|deviceId|name|timestamp|profileId when id is missing and is stable across two calls`; `returns null when event.profileId is missing`; `returns null for non-JSON-object input`; `parses timestamp given as ISO string and as epoch number`; `coerces property values to strings/numbers/booleans/null and drops nested objects`.
- [ ] **Step 2:** Run `bun test --isolate src/events/normalize.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `normalizeEvent` with zod `safeParse` over the `IncomingEventPayload` subset the plugin needs (`@openpanel/core` type import is allowed as `import type` only; otherwise declare the subset locally).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nudge): normalize topic events`.

### Task 5: Engine — store events, enroll, cancel, debounce

**Files:**
- Create: `src/engine/engine.ts`
- Test: `src/engine/engine.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` (Task 4), `RuleDefinition` (Task 3), `sql` and `resetNudgeTables` (Task 2).
- Produces: `createEngine(deps: { sql: typeof sql, now?: () => Date }): { handleEvent(e: NormalizedEvent): Promise<void>; purgeOldEvents(retentionDays: number): Promise<number>; interestNames(projectId?: string): Promise<Set<string>>; evaluateEnrollment(enrollmentId: string): Promise<{ met: boolean; missing: string[] }> }`. `evaluateEnrollment` is the single goal check used by `handleEvent` and by the ticker's send-time recheck (Task 6); it does not mutate state. `interestNames` returns the event names of active rules (trigger, goal, set-goal event) so the consumer can pre-filter.

Behavior contract for `handleEvent` (one transaction per event):
1. `INSERT INTO nudge.events ... ON CONFLICT (project_id, event_id) DO NOTHING`; if nothing was inserted (duplicate), return without further effects.
2. For every active rule of the project whose trigger event and filters match and, if `matchOn` is set, whose trigger event has that property: create an enrollment (`match_value` = the property value as string, or `''`) and one `steps` row per step with `due_at = trigger_time + delaySeconds`. Skip if an active enrollment exists for the same key. Re-entry: after a completed enrollment, a new one is created only if `reentry.enabled` and `cooldownSeconds` elapsed since its creation.
3. Immediately after creating an enrollment, evaluate the goal against stored events with `event_time >= trigger_time` (goal events that arrived before the trigger in arrival order but are later in event time count); if met, mark the enrollment `completed` and its pending steps `cancelled`.
4. For every active enrollment of the profile: goal `event` met when `name == goal.event` and (no `matchOn` or the event's `matchOn` property equals `match_value`); goal `set` met when the distinct values of `property` seen since `trigger_time` for the same match value cover the reference set `setKey` (and `missing = referenceSet − seen`); on met: enrollment `completed`, pending steps `cancelled`.
5. Inactivity goal: any event for the profile not in `excludeEvents` sets each pending step's `due_at = event_time + delaySeconds` (debounce).
6. Events with `event_time` earlier than an enrollment's `trigger_time` never count toward its goal (except in point 3's rule, which is by event time `>= trigger_time`).

- [ ] **Step 1: Write failing tests** (real DB; `resetNudgeTables()` in `beforeEach`; a fixed `now`): `trigger event enrolls the profile with step due_at = trigger_time + delaySeconds`; `a matching goal event completes the enrollment and cancels pending steps`; `goal event for a different match value does not cancel` (matchOn `book_id`: purchase of book A, goal event for book B); `two purchases of different books create two independent enrollments`; `trigger without the matchOn property does not enroll`; `event without a profile is never stored` (via Task 4 returning null, assert `handleEvent` is only called with normalized events — assert `events` table empty after a null normalize); `REVIEW FOCUS out-of-order: goal event handled first, then the trigger with an earlier event_time than the goal → enrollment is created already completed and no step stays pending`; `REVIEW FOCUS out-of-order: goal event with event_time earlier than the trigger_time does not complete the enrollment`; `REVIEW FOCUS redelivery: handling the same eventId twice creates one enrollment and one set of steps`; `set goal: sections s1,s2 seen of {s1,s2,s3} does not complete; seeing s3 completes; missing is [s3] before`; `inactivity: a later activity event moves pending due_at forward by its delay from that event; an excluded event does not`; `re-entry disabled: second trigger after completion creates nothing; enabled with cooldown elapsed creates a new enrollment`; `purgeOldEvents deletes events older than retention and keeps newer ones`; `SECURITY cross-project isolation: an event for project B never enrolls, completes or debounces project A's enrollment even with the same profile id and event names`; `handleEvents(batch) writes N events in one transaction and a failing event rolls the whole batch back`. Add `handleEvents(events: NormalizedEvent[]): Promise<void>` to the produced interface (same behavior as `handleEvent`, one transaction for the batch, events processed in `event_time` order).
- [ ] **Step 2:** Run `bun test --isolate src/engine/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `createEngine` in `src/engine/engine.ts` using `sql.$transaction` and raw SQL; keep rule matching in plain TypeScript functions in the same file (`matchesTrigger`, `evaluateGoal`) so they are unit-testable.
- [ ] **Step 4:** Run the engine tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nudge): engine enrollment, goals, debounce`.

### Task 6: Ticker, gates, send pipeline

**Files:**
- Create: `src/engine/gates.ts`, `src/engine/ticker.ts`, `src/channels/types.ts`, `src/channels/registry.ts`
- Test: `src/engine/gates.test.ts`, `src/engine/ticker.test.ts`

**Interfaces:**
- Produces in `channels/types.ts`: `type Recipient = { profileId: string, email?: string, deviceTokens: string[], attributes: Record<string, unknown> }`; `type RenderedMessage = { subject?: string, title?: string, body: string, meta: { projectId: string, enrollmentId: string, ruleId: string, stepIndex: number } }`; `type SendResult = { ok: true } | { ok: false, retryable: boolean, reason: string }`; `interface ChannelAdapter<C> { id: 'email'|'webhook'|'push'; configSchema: z.ZodType<C>; send(msg: RenderedMessage, to: Recipient, config: C, opts: { idempotencyKey: string }): Promise<SendResult> }`. `registry.ts`: `getAdapter(id): ChannelAdapter<unknown>`, `registerAdapter(a)`.
- Produces in `gates.ts`: `lagAllowsSending(state: { lag: number, updatedAt: Date } | null, now: Date, cfg: { maxLag: number }): boolean` (false when state is null, older than 60 s, or lag above `maxLag`); `inQuietHours(now: Date, q: { start: 'HH:mm', end: 'HH:mm', timezone: string } | null): boolean` and `nextAllowedTime(now: Date, q): Date`; `capAllows(count: number, caps: { max: number, periodSeconds: number } | null): boolean`.
- Produces in `ticker.ts`: `runTick(deps: { sql, engine: ReturnType<typeof createEngine>, now: () => Date, cfg: NudgeConfig, renderUnsubscribeUrl: (projectId, profileId, channel) => string }): Promise<{ sent: number, skipped: number, postponed: number, failed: number }>`.

`runTick` contract: (1) return all zeros when `lagAllowsSending` is false; (2) in a short transaction select `steps` with `status='pending'`, `due_at <= now - graceSeconds`, `FOR UPDATE SKIP LOCKED`, set `status='sending'`, `lease_until = now + leaseSeconds`, `attempt = attempt + 1`, commit; also reclaim rows whose `lease_until < now` and status `sending`; (3) for each claimed step, outside any transaction: recheck the goal with `engine.evaluateEnrollment(enrollmentId)` (if `met`, mark the enrollment completed, step `cancelled`); skip (`skipped`, outcome reason) when the profile is opted out of the channel, or email channel with no synced email, or push with no device tokens; apply quiet hours (postpone: set `status='pending'`, `due_at = nextAllowedTime`); apply the cap under `pg_advisory_xact_lock(hashtext(project||profile||channel))` counting `sent` steps within `periodSeconds` (over cap: `skipped`); render via Task 3 with `profile` from `contacts.attributes` and `event` from the trigger event's properties; send via the adapter with `idempotencyKey = enrollmentId:stepIndex`; mark `sent` with `sent_at`, or on `retryable` failure set `pending` again with `due_at = now + 60 s * attempt` (max 5 attempts, then `failed`), or `failed` when not retryable. A paused or deleted rule's pending steps are `cancelled` by Task 9's API; the ticker also skips steps whose rule status is not `active`.

- [ ] **Step 1: Write failing tests.** `gates.test.ts`: `lag gate false for null state, stale state (61 s), and lag above maxLag; true otherwise`; `quiet hours 22:00-08:00 in Asia/Kolkata: 23:00 local is inside, 12:00 is outside; nextAllowedTime from 23:00 is 08:00 next day`; `capAllows is false at count >= max, true below; true when caps is null`. `ticker.test.ts` (fake adapter registered; real DB): `REVIEW FOCUS lag: with consumer_state lag above maxLag nothing is claimed and the step stays pending`; `REVIEW FOCUS stale state: updated_at older than 60 s blocks sending`; `step due inside the grace window is not claimed; after it is`; `goal recheck cancels the step and sends nothing when a goal event with event_time >= trigger_time exists`; `REVIEW FOCUS opted out: email step is skipped, enrollment's next step is still pending and later sent`; `email step with no synced email is skipped`; `push step with no device tokens is skipped`; `quiet hours postpone instead of send`; `cap: with caps {max:1, periodSeconds:3600} a second step for the same profile and channel from another rule is skipped`; `two concurrent runTick calls send a due step exactly once` (Promise.all of two ticks, assert one fake-adapter call); `retryable failure re-queues with backoff and non-retryable marks failed`; `expired lease on a sending step is reclaimed`; `idempotencyKey passed to the adapter is enrollmentId:stepIndex`; `PERF a tick claims at most NUDGE_CLAIM_BATCH steps even with 1,000 due` and `sends run with at most NUDGE_SEND_CONCURRENCY in flight` (fake adapter tracking concurrent calls); `SECURITY an adapter error whose message contains the channel secret is logged redacted`.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement `gates.ts` (use `Intl.DateTimeFormat` with the timezone; no new dependency) and `ticker.ts` per the contract above.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nudge): ticker with lease, gates and caps`.

### Task 7: Channel adapters (webhook, email, push)

**Files:**
- Create: `src/channels/webhook.ts`, `src/channels/email.ts`, `src/channels/push.ts`
- Test: `src/channels/webhook.test.ts`, `src/channels/email.test.ts`, `src/channels/push.test.ts`

**Interfaces:**
- Consumes: `ChannelAdapter`, `RenderedMessage`, `Recipient`, `SendResult` (Task 6).
- Produces: `webhookAdapter` with config `{ url: string, secrets: string[] (1-2) }`; `emailAdapter` with config `{ host, port, secure, user?, pass?, from }` and `buildUnsubscribe(url: string)` input via `opts`; `pushAdapter` with config `{ serviceAccountJson: string }`. Each is registered in `registry.ts`.
- Webhook request: `POST` JSON `{ projectId, profileId, channel, subject?, title?, body, ruleId, enrollmentId, stepIndex }`, headers `x-nudge-timestamp` (epoch seconds), `x-nudge-signature` = `sha256=` + HMAC-SHA256 over `${timestamp}.${rawBody}` using `secrets[0]`, `idempotency-key`. Hosts in `NUDGE_WEBHOOK_ALLOW_HOSTS` use plain `fetch`; all others use `safeFetch` from `@openpanel/shared/server`. Response 429 and 5xx → `retryable: true`; other non-2xx → `retryable: false`.
- Email: nodemailer transport from config; adds `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; sends to `to.email` only; SMTP 4xx/connection errors → retryable, 5xx → not.
- Push: `firebase-admin` `messaging().sendEachForMulticast` to `to.deviceTokens`; tokens with `messaging/registration-token-not-registered` are returned to the caller for pruning via `SendResult` extended with `invalidTokens?: string[]` (add that optional field in Task 6's type when implementing this task and prune in the ticker); transient errors → retryable.

- [ ] **Step 1: Write failing tests**: webhook: `signature equals HMAC of timestamp.body with the first secret`, `sends idempotency-key header`, `429 and 503 are retryable, 400 is not`, `an internal host not in the allowlist is rejected as non-retryable and an allowlisted host is called` (local `Bun.serve` as target); email: `sets List-Unsubscribe and List-Unsubscribe-Post headers`, `does not send when recipient has no email` (returns `{ok:false, retryable:false}`), `421 response is retryable and 550 is not` (fake transport); push: `invalid tokens are reported in invalidTokens`, `empty deviceTokens returns non-retryable failure` (adapter's SDK call injected for the test).
- [ ] **Step 2:** Run the three files. Expected: FAIL.
- [ ] **Step 3:** Implement the adapters; extend `SendResult`'s failure branch/success branch with `invalidTokens?: string[]` and make the ticker delete those rows from `nudge.devices`.
- [ ] **Step 4:** Run the three files plus `src/engine/ticker.test.ts`. Expected: PASS; add a ticker test `invalid tokens returned by the push adapter are deleted from devices`.
- [ ] **Step 5: Commit** `feat(nudge): webhook, email and push adapters`.

### Task 8: Kafka consumer, interest pre-filter, lag reporter, worker entrypoint

**Files:**
- Create: `src/kafka/consumer.ts`, `src/kafka/interest.ts`, `src/kafka/lag.ts`, `src/worker.ts`
- Test: `src/kafka/consumer.test.ts`, `src/kafka/interest.test.ts`

**Interfaces:**
- Consumes: `normalizeEvent` (Task 4), `createEngine` (Task 5), `runTick` (Task 6), `loadConfig` (Task 1), `getRedisCache` from `@openpanel/redis`.
- Produces: `createMessageHandler(deps: { engine, interest: InterestSet }): (value: Buffer | null) => Promise<void>` in `consumer.ts` (parse → normalize → pre-filter → `engine.handleEvent`; malformed messages are logged and dropped, never throw); `interface InterestSet { has(projectId: string, name: string, profileId: string): Promise<boolean>; refresh(): Promise<void> }` with `createRedisInterestSet(redis, engine)` and `createMemoryInterestSet(engine)` in `interest.ts` (event names of active rules plus a per-project set of profile ids with active enrollments, shared across replicas through Redis); `startConsumer(cfg, handler): Promise<{ stop(): Promise<void> }>` using `kafkajs` directly, `fromBeginning: false`, offsets committed after the handler resolves; `reportLag(cfg, sql): () => Promise<void>` in `lag.ts` (admin `fetchTopicOffsets` minus group offsets summed, upserted into `nudge.consumer_state` every 10 s, which is also what `lagAllowsSending` reads).
- `worker.ts`: loads config, runs `migrate()`, starts the consumer, a ticker loop every `tickMs`, the lag reporter, a daily `purgeOldEvents`, and the HTTP server (Task 9); stops all on SIGTERM in reverse order.

- [ ] **Step 1: Write failing tests**: `handler drops a malformed message without throwing`; `handler ignores an event whose name is not in the interest set and whose profile has no active enrollment`; `handler passes an event for an enrolled profile even if its name is not a rule event (inactivity activity)`; `handler calls engine.handleEvent once per message`; `interest.refresh picks up a newly created active rule's event names`; `memory interest set reports a profile active after enrollment and inactive after completion`; `PERF the pre-filter rejects an uninteresting event without calling the engine or sql` (spy asserts zero calls); `eachBatch handler resolves offsets only after engine.handleEvents resolves, and a handleEvents rejection leaves offsets uncommitted`. The consumer uses `handleEvents` (Task 5) per batch instead of `handleEvent` per message.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement. The Kafka client builds from the env names in Global Constraints (SASL/SSL mapped to kafkajs options; copy the mapping logic, do not import `apps/api`).
- [ ] **Step 4:** Run both files. Expected: PASS. Then run one manual smoke from the repo root with the dev stack up: `bun run send track purchase --project acme-shop` and confirm a row appears in `nudge.events` when a rule exists for `purchase` (record the command output in the commit message body).
- [ ] **Step 5: Commit** `feat(nudge): kafka consumer, interest filter, lag state, worker`.

### Task 9: HTTP API (sync, dashboard, unsubscribe)

**Files:**
- Create: `src/api/server.ts`, `src/api/auth.ts`, `src/api/routes-sync.ts`, `src/api/routes-dashboard.ts`, `src/api/unsubscribe.ts`
- Test: `src/api/auth.test.ts`, `src/api/routes.test.ts`

**Interfaces:**
- Consumes: `sql`, `loadConfig`, `zRuleDefinition`, `renderTemplate`, `encryptCredential`/`decryptCredential` with `cfg.encryptionKey`, `hashPassword`/`verifyPassword`.
- Produces: `createServer(deps): { fetch(req: Request): Promise<Response> }` served by `Bun.serve({ port: cfg.port, fetch })` in `worker.ts`.
- Server-to-server routes (header `x-nudge-api-key: <id>.<secret>`; the key row stores `hashPassword(secret)`; successful verifications cached in memory for 5 minutes; the key's `project_id` scopes every call): `PUT /nudge/contacts/:profileId` body `{ email?: string, attributes?: object }`; `PUT /nudge/devices` body `{ profileId, token, platform: 'android'|'ios' }` (token unique globally, moves to the new profile); `DELETE /nudge/devices` body `{ token }`; `PUT /nudge/reference-sets/:setKey` body `{ values: string[] }`.
- Dashboard routes (headers `x-nudge-proxy-secret` equal to `cfg.proxySecret` compared in constant time, plus `x-nudge-project-id` and `x-nudge-user-id`; mutating requests also require `x-nudge-csrf: 1`): `GET/POST /nudge/rules`, `PATCH/DELETE /nudge/rules/:id` (pausing or deleting sets the rule's pending steps to `cancelled` and its active enrollments to `cancelled` in one transaction; editing bumps `version` and affects only new enrollments), `GET /nudge/starter-rules`, `GET/PUT /nudge/channels/:channel` (config validated with the adapter's `configSchema`, stored encrypted, returned with secrets masked), `GET/PUT /nudge/settings` (caps, quiet hours), `GET /nudge/results?ruleId=` (per rule: enrolled, sent, completed-after-send, conversion rate, skipped, failed), `POST /nudge/api-keys` (returns the secret once), `POST /nudge/preview` (renders a template with sample variables), `PUT /nudge/reference-sets/:setKey`, `GET /nudge/reference-sets`.
- Public: `GET /nudge/unsubscribe?t=` shows a confirmation page, `POST /nudge/unsubscribe?t=` (one-click, RFC 8058) inserts into `opt_outs`; the token is `base64url(projectId|profileId|channel|hmac)` signed with `cfg.encryptionKey`. `GET /nudge/health` returns `{ ok: true }`.

- [ ] **Step 1: Write failing tests**: `sync routes reject a missing or wrong api key with 401`; `a key for project A cannot write contacts for project B` (scoping); `PUT devices moves an existing token to the new profile`; `DELETE devices removes it`; `dashboard routes reject a missing or wrong proxy secret with 401 and a mutating call without x-nudge-csrf with 403`; `POST rules validates with zRuleDefinition and returns 400 on invalid`; `pausing a rule cancels its pending steps and active enrollments`; `PUT channels stores config encrypted (raw column does not contain the secret) and GET masks it`; `results counts match seeded steps`; `unsubscribe POST with a valid token inserts an opt-out and a tampered token returns 400`; `preview escapes HTML in variables`; `SECURITY a body over 1 MiB returns 413`; `SECURITY a template body over 20,000 characters returns 400`; `SECURITY the 31st failed api-key attempt from one IP within a minute returns 429`; `SECURITY an unsubscribe token signed with ENCRYPTION_KEY directly (not the HKDF-derived key) is rejected`; `SECURITY GET channels never returns a secret value, even masked values do not reveal length`; `SECURITY proxy-secret comparison is constant time` (assert the code path uses `crypto.timingSafeEqual` via a spy); `SECURITY dashboard rule ids from another project return 404`.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement with a small path-matching router over `Request`/`Response` (no framework), zod validation on every body.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nudge): http api`.

### Task 10: Dashboard module (new files in apps/start) and sidebar entry

**Files:**
- Create: `apps/start/src/components/nudge/{contract.ts,api.ts,rules-page.tsx,rule-editor.tsx,channels-page.tsx,results-page.tsx}`; `apps/start/src/routes/_app.$organizationId.$projectId.nudge._tabs.tsx`, `...nudge._tabs.index.tsx`, `...nudge._tabs.channels.tsx`, `...nudge._tabs.results.tsx`, `apps/start/src/routes/api/nudge.$.tsx`
- Modify (the only existing-file edit, already approved): `apps/start/src/components/sidebar-project-menu.tsx` — add one multi-line `<SidebarLink exact={false} href={'/nudge'} icon={WorkflowIcon} label="Nudges" />` after the Integrations link; update `TOUCHPOINTS.md` status.
- Test: `apps/start/src/components/nudge/contract.test.ts` (vitest, `bunx vitest run` in `apps/start`)

**Interfaces:**
- `contract.ts`: a zod copy of `zRuleDefinition` and the response types (kept in sync with Task 3 by a comment-free parity test below); `api.ts`: `nudgeFetch<T>(path: string, init?: RequestInit): Promise<T>` calling `/api/nudge/<path>` with `x-nudge-csrf: 1`.
- `routes/api/nudge.$.tsx`: `createFileRoute('/api/nudge/$')` with `server.handlers` for GET/POST/PUT/PATCH/DELETE. It reads the session cookie from the request, calls core's tRPC `project.getProjectWithClients({ projectId })` at `$API_URL/trpc` with that cookie (projectId from the `x-nudge-project-id` header the UI sets); non-2xx or forbidden → 403. On success it forwards the request to `NUDGE_URL` with `x-nudge-proxy-secret` (from `NUDGE_PROXY_SECRET`), `x-nudge-project-id`, `x-nudge-user-id`, and the original `x-nudge-csrf`; caches the access decision per (cookie hash, project) for 30 s; returns 404 when `NUDGE_URL` is unset.
- Screens: Rules list with "Add rule" and "Start from template" (STARTER_RULES via `GET /nudge/starter-rules`); **rule editor is a vertical timeline with a form per step**: trigger and goal at the top (goal kind select: event / set / inactivity), a "match on property" field, then steps as nodes on a line (delay, channel, subject/body with live preview via `POST /nudge/preview`), a visible marker "goal cancels the rest", reference-set editor when goal kind is `set`; Channels tab (one card per adapter, form generated from its fields, secrets masked); Results tab (table from `GET /nudge/results`).

- [ ] **Step 1: Write failing tests** in `contract.test.ts`: `contract accepts the same starter rules the service defines` (import a JSON fixture copied from `STARTER_RULES` and assert `zRuleDefinition.parse` passes); `contract rejects a rule with non-increasing delays`.
- [ ] **Step 2:** Run `bunx vitest run src/components/nudge` in `apps/start`. Expected: FAIL.
- [ ] **Step 3:** Implement `contract.ts`, `api.ts`, the pages, editor and routes following the patterns in `routes/_app.$organizationId.$projectId.notifications._tabs*.tsx` and `components/notifications/*`; regenerate `routeTree.gen.ts` by running the dashboard dev server once; make the sidebar edit.
- [ ] **Step 4:** Run `bunx vitest run src/components/nudge`, `bun run typecheck` at the root, then `npx ultracite check` on only the files created or changed in this task. Expected: PASS and clean.
- [ ] **Step 5: Verify like a user** (repo AGENTS.md method): with the dev stack, `nudge-worker`, and `NUDGE_URL`/`NUDGE_PROXY_SECRET` set, open `$DASHBOARD_URL`, log in with the seeded user from `.seed.json`, open Nudges, create a rule from the "cart abandoned" template, add an email channel, save, and take a screenshot of the timeline editor; confirm the dashboard of a user without project access receives 403 from `/api/nudge/rules`.
- [ ] **Step 6: Commit** `feat(nudge): dashboard module and sidebar entry`.

### Task 11: Deploy wiring, CI, end-to-end proof

**Files:**
- Create: `packages/nudge/Dockerfile`, `docker-compose.nudge.yml`, `.github/workflows/nudge.yml`, `packages/nudge/scripts/e2e.ts`
- Modify: `packages/nudge/README.md`

**Interfaces:**
- `docker-compose.nudge.yml`: service `op-nudge` building `packages/nudge/Dockerfile`, env from the Global Constraints list, `NUDGE_PORT`, depends on the existing Postgres, Redis and Redpanda services; adds `NUDGE_URL` and `NUDGE_PROXY_SECRET` to the existing dashboard service as an override; documented as an override file for `openpanel init` installs.
- `.github/workflows/nudge.yml`: on pull requests touching `packages/nudge/**` or `apps/start/src/components/nudge/**`: install, `bun run --filter @openpanel/nudge typecheck`, `bun run --filter @openpanel/nudge test` against Postgres and Redis service containers, build the image.
- `scripts/e2e.ts`: against a running dev stack, creates a rule (`add_to_cart` trigger, `purchase` goal, one webhook step at +10 s with `NUDGE_GRACE_SECONDS=0`) via the dashboard API, sends `add_to_cart` for a seeded profile through `POST $API_URL/track`, waits for a local webhook receiver, asserts one signed delivery, then repeats with a `purchase` sent before the step is due and asserts zero deliveries.

- [ ] **Step 1:** Write the Dockerfile (Bun slim base like `apps/api/Dockerfile`'s pattern, installs workspace with `--frozen-lockfile --linker=isolated`, runs `bun src/worker.ts`), compose override, workflow, and e2e script.
- [ ] **Step 2:** Run the full plugin suite: `bun test --isolate` in `packages/nudge` and `bun run typecheck` at the root. Expected: all PASS.
- [ ] **Step 3:** Run `bun run dock:up`, start `nudge-worker` (`bun run --filter @openpanel/nudge start`) and the API, then `bun packages/nudge/scripts/e2e.ts`. Expected: prints `PASS delivered once` and `PASS cancelled by goal`. Capture the output.
- [ ] **Step 4:** Confirm fork discipline: `git diff --name-status <base>..HEAD` shows only added files, except the allowlisted `sidebar-project-menu.tsx`, `routeTree.gen.ts` and `bun.lock` (modified). Any other `M` line is a violation to fix.
- [ ] **Step 5: Commit** `feat(nudge): deploy wiring, CI and e2e`.

### Task 12: Load and security verification

**Files:**
- Create: `packages/nudge/scripts/load.ts`, `packages/nudge/src/api/rate-limit.ts`, `packages/nudge/src/redact.ts`
- Test: `src/api/rate-limit.test.ts`, `src/redact.test.ts`

**Interfaces:**
- Produces: `createRateLimiter(opts: { limit: number, windowMs: number, now?: () => number }): { take(key: string): boolean }` (in-memory token bucket per key; used by Task 9 for failed API-key attempts and unsubscribe calls, wired in this task); `redactSecrets(input: unknown, secrets: string[]): string` (replaces every secret occurrence and any `Bearer ...` or `private_key` value with `[redacted]`; used by the ticker's error logging).
- `scripts/load.ts` seeds into schema `nudge` (never touching `public`): 1,000,000 pending steps and 100,000 active enrollments, then reports (a) the claim query time, (b) `handleEvents` throughput for 100,000 synthetic events with 95% not in the interest set, (c) `runTick` time for a 200-step batch with a no-op adapter, and prints measured values next to the targets in Global Constraints.

- [ ] **Step 1: Write failing tests**: `rate limiter allows 30 then rejects the 31st within the window and allows again after the window` (injected clock); `rate limiter keys are independent`; `redactSecrets removes a webhook secret, a Bearer token and a private_key value from an Error message and a JSON string`; `redactSecrets leaves unrelated text unchanged`.
- [ ] **Step 2:** Run `bun test --isolate src/api/rate-limit.test.ts src/redact.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement both modules; wire the limiter into the Task 9 routes (failed key attempts, unsubscribe) and `redactSecrets` into the ticker's adapter-error logging; make the Task 9 and Task 6 tests named `SECURITY` pass.
- [ ] **Step 4:** Run the whole suite (`bun test --isolate` in `packages/nudge`). Expected: PASS.
- [ ] **Step 5:** Run `bun packages/nudge/scripts/load.ts` against the dev Postgres. Expected: prints the three measurements; if any misses its target, record the number and the query plan in the commit message body and report it to the user instead of changing the target.
- [ ] **Step 6: Commit** `feat(nudge): rate limiting, redaction, load check`.

---

## Self-Review

- **Spec coverage:** rule model and three goal kinds (Tasks 3, 5); sequences and cancel (5); channels email/webhook/FCM (7); templates, escaping, allowlist (3); caps, quiet hours, grace, lag gating, lease, advisory lock (6); event-time evaluation and out-of-order handling (5); dedupe/idempotency (4, 5); reference sets, contacts, devices sync with API key (2, 9); opt-out and unsubscribe (6, 9); Redpanda own group, `fromBeginning: false` (8); schema `nudge` and migrations (2); dashboard timeline UI, proxy route, tRPC auth, shared secret (10); results screen (9, 10); starter rules (3); CI/Docker without edits (11); fork discipline check (11); performance limits and load check (Global Constraints, 2, 5, 6, 8, 12); security limits, rate limiting, redaction, tenancy isolation (Global Constraints, 5, 6, 9, 12). Gaps: none found.
- **Spec deviation (decided here):** one `events` table replaces the spec's separate facts, seen-values and processed-events tables (same semantics: unique `(project_id, event_id)` is the dedupe; goal/activity/seen values are queries over it). Consumer progress uses lag plus state freshness instead of a per-partition event-time watermark; the grace window plus send-time goal recheck cover late events.
- **Type consistency:** `NormalizedEvent` (Task 4) is the only input to `handleEvent` (5) and the handler (8); `RenderedMessage`/`Recipient`/`SendResult` (6) are used unchanged by adapters (7); `SendResult.invalidTokens` is added in Task 7 and consumed by the ticker in the same task.
- **Proportion:** the plan states interfaces, contracts and tests, not bodies.
