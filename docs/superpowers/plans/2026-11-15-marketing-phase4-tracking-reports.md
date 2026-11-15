# Marketing Phase 4 (tracking and reports) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every campaign and journey message gets a tracked status (sent, delivered, failed, skipped, uncertain, read, clicked, converted) from MSG91 delivery webhooks, FCM results, signed click redirects and the student's app-open event, and the Results tab shows per-campaign and per-journey reports. No student contact data is stored.

**Architecture:** A new table `marketing.message_tracking` holds one row per message. Its key is the existing ledger `source_ref` (`campaign:<campaignId>:<profileId>` or `step:<enrollmentId>:<stepIndex>`), and a row holds ids, a furthest status and set-once milestone timestamps. Row triggers on `campaign_recipients` and `steps` fill it from every statement that finalises a send, so the send path's SQL and its at-most-once guarantees are unchanged.
- **Delivery reports.** MSG91 reports arrive on a public webhook with a per-project secret in the path. They are matched to rows by request id plus a phone comparison done in process memory, against the audience API lookup of the ≤100 students who share that request id.
- **Clicks.** Links in push and email are rewritten to `<campaignUrl>/marketing/r/<token>`. The token is AES-256-GCM authenticated encryption (sealed `[sourceRef, linkId, expiry]`) under a per-project key. The redirect target is read from `marketing.tracked_links`, never from the token.
- **Conversions.** These are matched in the Kafka batch handler before the interest filter, one statement per batch.
- **Reports.** These are SQL aggregates over the tracking rows plus aggregate per-state counters for journeys.

**Tech Stack:** Bun, TypeScript, zod, Postgres (plain-SQL migrations in `packages/marketing/migrations/`), `node:crypto` (HKDF, AES-GCM, SHA-256), bun test; dashboard: TanStack Start, React 19, @tanstack/react-query, Recharts, Tailwind v4, vitest (pure TS, no jsdom).

**Spec:** `docs/superpowers/specs/2026-11-15-marketing-phases-3-5-design.md` (section "Phase 4: tracking and reports" and the decisions table, binding), building on `docs/superpowers/specs/2026-10-28-marketing-platform-design.md` (delivery status, retention item 21, public URL item 23). Depends on Phase 3 being built: `docs/superpowers/plans/2026-11-15-marketing-phase3-journeys-templates-email.md` (migrations 0016 to 0018, `chooseMessage`, exported ticker `render`, email `compileEmailContent`, `routes-journeys.ts`). This plan's first migration is `0019`.

## Global Constraints

- Student data is never copied: no phone, email, token or trait value in any marketing table, Redis key or log; the dashboard shows ids and masked displayName only.
- At-most-once sending is unchanged.
- Opt-out is out of scope.
- A/B tests are out of scope.
- Commit trailer exactly `Co-Authored-By: Claude <noreply@anthropic.com>`.
- No breaking-change markers: no `!`, `BREAKING CHANGE`, `[major]`, `[minor]`, `[release now]`.
- Never push.
- One writer agent at a time.
- Dashboard logic in pure helpers with vitest (no jsdom). Backend tests `bun test --isolate` with the test env.
- Upgrade notes for new env vars and migrations (this plan adds no env var; it adds migration `0019` and two public paths, see Task 11).
- Test env (unchanged from phase 2): from `packages/marketing`, `MARKETING_ALLOW_RESET=1`, `DATABASE_URL` on a database whose name ends in `_test`, `REDIS_URL` on db index 6, containers `docker compose -p nudge up -d op-db op-kv op-rp`; run one test command at a time (low memory). Dashboard: `bunx vitest run src/components/marketing` in `apps/start`. Before each commit: `bun run typecheck` at the repo root and `npx ultracite fix <touched files>`.
- Phase 3's rule stands: nothing per student records the student's state or which variant was chosen. Per-state numbers are aggregate counters with no profile id (Task 8).
- No new npm dependency in either package.
- The dashboard never imports from `packages/marketing/src`; it keeps its own zod copy. The block in `contract.ts` that must stay text-identical to `rule.schema.ts` is not touched; new report and settings types go below it.
- Fork discipline, quoted verbatim from `packages/marketing/AGENTS.md` (binding on every agent and implementer):

  > This repository is a fork of upstream OpenPanel and must stay updatable from
  > upstream at any time. **Do not modify, rename, move, reformat or delete any
  > existing file or directory.** That includes `packages/core`, `packages/db`
  > (including `prisma/schema.prisma` and its migrations), `apps/api`,
  > `apps/start`, root configs, `AGENTS.md`/`CLAUDE.md`, and tests. Do not run
  > formatters, `bun run fix` or codemods over files you did not create.
  >
  > - All plugin code lives in **new files**: the service, migrations, docs and
  >   tests under `packages/marketing/`; the dashboard UI under new directories in
  >   `apps/start/src/` (e.g. `components/marketing/`) plus new route files in
  >   `apps/start/src/routes/`. The UI is not imported from `packages/marketing`
  >   (review finding: `apps/start` can only resolve dependencies in its own
  >   `package.json`, and Tailwind would not scan another package). It talks to the
  >   service over HTTP and keeps its own zod contract copy.
  >   Adding a new file in an existing directory is fine; editing an existing file
  >   is not.
  > - Deploy wiring is new files too (e.g. `docker-compose.marketing.yml`), not edits
  >   to `docker-compose.yml`.
  > - Plugin agent instructions go in `packages/marketing/AGENTS.md` (new), never in
  >   the root `AGENTS.md`.
  > - Use only public package surfaces. Never import `@openpanel/core` internals
  >   or reach into another package's `src/`.
  > - **Allowlist of unavoidable edits to existing files** (each needs the user's
  >   explicit approval before it is made, and is recorded in
  >   `packages/marketing/TOUCHPOINTS.md`): (1) one nav entry in
  >   `apps/start/src/components/sidebar-project-menu.tsx` (**approved by the
  >   user**; one `<SidebarLink>` element only, formatted the way the repo's
  >   formatter formats the neighbouring links, reusing the already-imported
  >   `WorkflowIcon` so the import block is not touched; for now, until upstream
  >   offers a plugin hook); (2) regenerated
  >   `apps/start/src/routeTree.gen.ts` and `bun.lock`, which tooling rewrites and
  >   which are regenerated, not hand-merged, on upstream updates. Anything not on
  >   this list: stop and ask the user. Do not work around the rule.
  > - If a task seems to require editing an existing file, treat it as a design
  >   problem to raise, not permission to edit.
  > - Every implementation plan and every subagent prompt for this work must
  >   quote this section.

  Every file this plan modifies is a plugin file (under `packages/marketing/`, `apps/start/src/components/marketing/`, or `apps/start/src/routes/marketing*`). The new route files regenerate `routeTree.gen.ts`, which is on the allowlist.

## Facts this plan relies on

Verified in code:
- **One request id per batch.** MSG91 SMS and WhatsApp send up to 100 recipients per request and return one request id per request (`channels/msg91-http.ts` `requestIdOf`, `msg91-whatsapp.ts` `readResponse`). Every recipient of a batch gets that id as `campaign_recipients.provider_ref`, so a report's request id alone cannot identify the row; the phone number tells recipients apart.
- **Recipient statuses.** `campaign_recipients.status` ∈ `pending, leased, sending, sent, uncertain, failed, skipped`. They are finalised by `MARK_SENDING_SQL` (capped → skipped), `MARK_OUTCOMES_SQL`, `markLeasedFinal`, the lease reaper (→ uncertain) and `operator.ts` (`retryUncertain` sets uncertain rows back to pending, and they can then become sent).
- **Journey step statuses.** `steps.status` ∈ `pending, sending, sent, skipped, failed, cancelled`. Ordinary sends are finalised by ticker `MARK_SQL` (reason in `outcome->>'reason'`; `recordSendResult` finishes `sent` or `failed` with a redacted reason). Journey channels are email, webhook and push, never MSG91.
- **Push.** Push is sent per recipient over FCM, and the result is only accepted (sent) or failed. FCM gives no server-side delivered or read report, so push shows those as "not reported".
- **Links in templates.** Campaign push has a `link` field (`campaign/definition.ts` `zPushTemplate`, put in `data.link` by `dispatch.ts` `pushExtras`), and `zLink` allows app schemes such as `sia://`. Phase 3 email blocks have `button.url` (https, no `{{`). Phase 3 journey push steps have no link field. SMS and WhatsApp send provider-approved templates (DLT), so their text is never rewritten.
- **Public paths.** Public paths reach the service through a pass-through on the dashboard origin (`marketing.unsubscribe.tsx` + `unsubscribe-proxy.ts`, `redirect: 'manual'`, forwards `x-forwarded-for`, does not pass `location`). `MARKETING_PUBLIC_URL` is the dashboard's public origin.
- **Existing helpers.** HKDF key derivation from `ENCRYPTION_KEY` is in use (`api/unsubscribe.ts` `unsubscribeKey`). `createRateLimiter` exists (`api/rate-limit.ts`). Chunked deletes go through `deleteInChunks` (`engine/engine.ts`). The worker's hourly purge loop is in `worker.ts`. `LEDGER_RETENTION_DAYS = 400`.
- **Kafka batches.** `createBatchHandler` (`kafka/consumer.ts`) normalizes events (`projectId`, `profileId`, `name`, `time`), then drops every event the interest set does not know. Campaign recipients are not in the interest set.

Not verified:
- **Crashed journey sends.** It is not checked how the ticker finalises a step whose `sending` lease expired (`CLAIM_SQL` `expired` arm and what follows). Task 1 reads it first. If such a step ends `failed` with a reason that means "may have been sent", the step trigger maps it to `uncertain` (rank 1, still upgradeable), and the Task 1 test for that path asserts it.

Fixtures only, see owner question 3:
- **MSG91 report shapes.** SMS reports are taken to arrive as a JSON array, or `{ data: [...] }`, or a form field `data` holding that JSON, of `{ requestId, report: [{ number, status, desc, date }] }` with numeric status `1` meaning delivered and `2, 9, 16, 17, 25, 26` meaning failed. WhatsApp reports are taken to be objects (or arrays of them) with `requestId`, `customerNumber` and `status` ∈ `sent, delivered, read, failed`. The parser is fixture-driven so a captured payload only changes fixtures and the mapping table.

## Design decisions (made here, binding on the tasks)

1. **Mapping tokens and reports to rows without contact data.** A row is keyed by `source_ref`, which is ids only.
   - A link token seals `[sourceRef, linkId, expiresAtSeconds]` with AES-256-GCM. The key is `hkdf('sha256', ENCRYPTION_KEY, salt = projectId, info = 'marketing-link-v1', 32)`. The token text is `<projectId>.<base64url(iv12 ‖ ciphertext ‖ tag16)>`, so nothing in it is readable and any change fails the tag.
   - An MSG91 report is matched by `(project_id, provider_ref = requestId)`, then by phone. The service looks up the profile ids of those rows through `sources.forProject(projectId).lookup(ids, channel)` and keeps, in memory only, `sha256(digits)` → `source_ref`. The map is cached per request id for 15 minutes and holds at most 2,000 request ids.
   - Numbers are compared by their last 10 digits: the map key is `sha256(last 10 digits)`, and a number with fewer than 10 digits, on either side, never matches. This is a shortcut: two recipients of one batch with the same last 10 digits are indistinguishable. Upgrade to the channel's country-code normalisation if non-Indian numbers are sent.
   - **Early reports.** A report can arrive before the dispatcher's mark commits, so its request id has no rows yet.
     - An empty row set is never cached.
     - Reports whose request id has no rows are held in memory for up to 2 minutes (at most 10,000 reports per process; beyond that, or after the hold, they are dropped and counted in a log line with no content) and retried every 10 s.
     - The call still answers 200.
     - Reports for request ids with rows but no matching phone are dropped (unmatched).
   - Nothing phone-derived is written anywhere.
2. **Status order (furthest status wins).** `skipped (0) < uncertain (1) < sent (2) < failed (3) < delivered (4) < read (5) < clicked (6) < converted (7)`. A write only raises the status. Milestone timestamps are each set once (`COALESCE`):
   - `accepted_at`: the provider accepted the message. Set on `sent`, and on any later delivered, read, click or conversion as evidence.
   - `delivered_at`: set by delivered or read.
   - `read_at`, `clicked_at`, `converted_at`.
   - `failed_at`: set only while the status is below `failed`.
   Consequences:
   - Duplicates are no-ops. A late `delivered` after `read`, or a `failed` after `delivered`, changes nothing.
   - A retried uncertain recipient that is then sent moves up (1 → 2).
   - A send-time failure (`accepted_at` NULL) is told apart from a provider-reported failure (`accepted_at` set).
   - The funnel counts milestones, not ranks, because a conversion does not imply a click.
3. **Write path.** Row triggers `AFTER INSERT OR UPDATE OF status … FOR EACH ROW WHEN (NEW.status IN (...))` on `campaign_recipients` and `steps` upsert the tracking row in the same statement as the mark. This covers all six finalising paths, including future ones, without editing them.
   - The trigger has no constraint a mark can violate: the status check matches the `WHEN` list and `channel` is nullable. A trigger failure is therefore only a database failure that would fail the mark anyway, and the trigger never sends.
4. **Retention.** Tracking rows and per-state counters are purged after `LEDGER_RETENTION_DAYS` (400) by the hourly purge, in chunks. Link tokens expire after `LINK_TOKEN_TTL_DAYS = 90`. `tracked_links` rows are kept (one per distinct URL per project); this is marked as a shortcut in code.
5. **Load at 20,000 recipients.**
   - Triggers add one indexed upsert per finalised recipient, in the dispatcher's existing batches.
   - Each webhook call is one `UPDATE … FROM unnest(...)`, with no counter row to contend on, because reports are aggregates at read time.
   - Lookups happen at most once per request id: 20,000 SMS means 200 lookups.
   - Each Kafka batch costs one conversion statement, using a partial index.
   - Multi-row tracking updates (webhook, conversion) lock their rows in `source_ref` order (`SELECT … ORDER BY source_ref FOR UPDATE` in the same statement), so concurrent duplicate calls cannot deadlock.
   - Indexes:
     - `(provider_ref) WHERE provider_ref IS NOT NULL`
     - `(project_id, profile_id, sent_at DESC) WHERE accepted_at IS NOT NULL`
     - `(campaign_id, sent_at) WHERE campaign_id IS NOT NULL`
     - `(rule_id, sent_at) WHERE rule_id IS NOT NULL`
     - `(sent_at)`
6. **Public redirect endpoint.**
   - It exposes only the opaque token. It answers 302 to the URL stored for that link id and project, 404 for a bad token and 410 for an expired one, with `cache-control: no-store`, `referrer-policy: no-referrer` and `x-robots-tag: noindex`.
   - Invalid tokens are rate-limited per IP (`createRateLimiter`, 429). Valid tokens are not limited, because many students can share one forwarded IP; a repeat click writes nothing (`WHERE clicked_at IS NULL`).
   - A failed click write is logged and the student is still redirected.
   - There is no open redirect: the URL comes only from `marketing.tracked_links` where `id = linkId AND project_id = token's project`.
7. **Which links are tracked.** Only `http(s)` URLs that contain no `{{` in the template are tracked: the push `link` and email `href` values (body and plain-text alternative). Links are registered before personalisation, so no student value can land in `tracked_links`.
   - App-scheme push links, SMS, WhatsApp, webhook and test sends are left unchanged.
   - Rewriting is on only when the project's `campaignUrl` is set (an opt-in, so an upgrade changes nothing).
8. **Webhook auth.**
   - The URL is `<publicUrl>/marketing/webhooks/msg91/<projectId>/<secret>`, where `secret = base64url(hkdf(ENCRYPTION_KEY, salt = projectId, info = 'marketing-msg91-webhook-v1', 32))`. It is compared in constant time, and failures are rate-limited per IP.
   - Updates are always scoped to that `project_id`, so one project's secret cannot touch another project.
   - The path and body are never logged.
   - If the audience source fails, the webhook answers 503 so the provider can retry.
9. **Conversion.** The event name is `tracking.conversionEvent`, and the window is `conversionWindowDays` (default 7, 1 to 30). A conversion counts when the event time is at or after `sent_at`, before `sent_at + window`, and not more than 5 minutes in the future.
   - The message credited is the latest eligible message for that student (`accepted_at IS NOT NULL AND status <> 'failed'`), ties broken by `source_ref`. If that message is already converted it absorbs the event and no older message is credited.
   - Matching runs before the interest filter. It is idempotent, so a failed batch is replayed by the existing retry, and a replay changes nothing.
10. **Public URL override.** The dashboard's `publicUrl` (null means `MARKETING_PUBLIC_URL`) moves the project's unsubscribe links and its webhook URL. `campaignUrl` (null means no link tracking) is the host for redirects. Changes take effect within 60 s (settings cache).

## Review Focus

1. **Duplicate and out-of-order delivery reports.** Examples: MSG91 retries the same report, or `read` arrives before `delivered`, or `failed` arrives after `delivered`, or several reports for one number arrive in one call. Expected: the status never moves backwards, every timestamp is set once, and counts do not double. Test in Task 5.
2. **A forged webhook or link token.** Examples: a wrong secret, one project's secret used on another project's path, a token with one byte changed, a token sealed for project A replayed with project B's prefix, an expired token. Expected: 401 or 404/410, nothing written, and a 429 after repeated failures. Tests in Task 3 (token) and Task 6 (webhook).
3. **Redirect abuse.** Examples: an attempt to redirect to an arbitrary URL (a `url=` query, a forged link id, a link id from another project), a flood of garbage tokens, the same valid link clicked 1,000 times. Expected: only the stored URL is ever a `Location`, garbage tokens hit 429, and repeat clicks cause no writes. Test in Task 4.
4. **A conversion counted twice or credited to the wrong message.** Examples: two app opens after one message, an app open before the message, an app open after the window, a newer failed message next to an older delivered one, the same Kafka batch replayed, two messages from different campaigns. Expected: exactly one conversion, on the latest eligible message. Test in Task 7.
5. **A flood of webhook calls at 20,000 recipients.** 20,000 single-report calls over 200 request ids, at 50 concurrent. Expected: at most 200 audience lookups, all 20,000 rows delivered, no error, and nothing phone-derived stored. Test in Task 6.

---

### Task 1: Tracking table, status order, triggers and purge

**Files:**
- Create: `packages/marketing/migrations/0019_message_tracking.sql`, `packages/marketing/src/tracking/status.ts`, `packages/marketing/src/tracking/purge.ts`
- Modify: `packages/marketing/src/worker.ts` (purge loop)
- Test: `packages/marketing/src/tracking/status.test.ts`, `packages/marketing/src/tracking/triggers.test.ts`, `packages/marketing/src/db/migrate.test.ts`

**Interfaces:**
- Consumes: Phase 3 migrations 0016 to 0018 already applied.
- Produces:
  - Table `marketing.message_tracking`:
    - `source_ref text PRIMARY KEY`, `project_id text NOT NULL`, `profile_id text NOT NULL`, `channel text NULL`
    - `campaign_id uuid NULL`, `rule_id uuid NULL`, `step_index int NULL`
    - `status text NOT NULL CHECK (status IN (<the 8>))`, `reason text NULL`, `provider_ref text NULL`
    - `sent_at timestamptz NOT NULL`, and `accepted_at`, `delivered_at`, `read_at`, `clicked_at`, `converted_at`, `failed_at timestamptz NULL`
    - The five indexes of decision 5.
  - SQL function `marketing.message_status_rank(text) RETURNS int IMMUTABLE` (the order of decision 2, unknown values return -1).
  - Trigger `track_campaign_recipient` on `marketing.campaign_recipients`, `WHEN NEW.status IN ('sent','uncertain','failed','skipped')`. It upserts with:
    - `source_ref 'campaign:'||campaign_id||':'||profile_id`; channel from `campaigns`; `campaign_id`; `reason`; `provider_ref`
    - `sent_at = COALESCE(NEW.sent_at, NEW.updated_at)`; `accepted_at` = that time when `NEW.status = 'sent'`
    - On conflict: status = the higher rank; `reason` follows the status when it changes; `provider_ref = COALESCE(new, old)`; `sent_at = new` (a retry moves it); `accepted_at = COALESCE(old, new)`.
  - Trigger `track_journey_step` on `marketing.steps`, `WHEN NEW.status IN ('sent','failed','skipped')`. Same upsert, with `source_ref 'step:'||enrollment_id||':'||step_index`, project/profile/rule from `enrollments`, channel `rule_snapshot->'steps'->step_index->>'channel'`, reason `NEW.outcome->>'reason'`, `sent_at = COALESCE(NEW.sent_at, now())`.
  - Table `marketing.tracked_links (id uuid PRIMARY KEY, project_id text NOT NULL, url text NOT NULL CHECK (length(url) <= 2000), created_at timestamptz NOT NULL DEFAULT now())` with `UNIQUE INDEX (project_id, md5(url))`.
  - Table `marketing.journey_variant_counts (project_id text NOT NULL, rule_id uuid NOT NULL, step_index int NOT NULL, variant_key text NOT NULL, day date NOT NULL, sent int NOT NULL DEFAULT 0, skipped int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0, PRIMARY KEY (rule_id, step_index, variant_key, day))`. `variant_key` is `'default'`, an operator variant key, or `''` for "no message fitted".
  - `ALTER TABLE marketing.project_settings ADD COLUMN IF NOT EXISTS tracking jsonb NULL`.
  - Backfill: rows from `campaign_recipients` and `steps` already in a final status with send time within 400 days, mapped as the triggers map them (`ON CONFLICT DO NOTHING`).
  - `status.ts`:
    - `MESSAGE_STATUSES = ['skipped','uncertain','sent','failed','delivered','read','clicked','converted'] as const` (rank order)
    - `type MessageStatus`
    - `statusRank(status: MessageStatus): number`
    - `MILESTONES = ['accepted','delivered','read','clicked','converted','failed'] as const`
  - `purge.ts`: `purgeTracking(sql: Sql, opts?: PurgeOptions): Promise<{ messages: number; variantCounts: number }>`. It deletes rows older than `LEDGER_RETENTION_DAYS`, using `deleteInChunks` for `message_tracking`. It does not touch `tracked_links`, with a `shortcut:` comment.
  - `worker.ts`: `every(PURGE_INTERVAL_MS, 'purge tracking', secrets, () => purgeTracking(sql))`.

- [ ] **Step 1: Write failing tests.**
  - `status.test.ts`: `the SQL rank function orders statuses exactly as MESSAGE_STATUSES` (query `message_status_rank` for each status and assert ascending `0..7`).
  - `triggers.test.ts`, each driving the real path, not raw inserts:
    - `a sent recipient gets a tracking row with accepted_at and provider_ref` (`markOutcomes`)
    - `a capped recipient is tracked as skipped` (`markSending`)
    - `a lookup skip is tracked as skipped with its reason` (`markLeasedFinal`)
    - `a reaped sending recipient is tracked as uncertain` (reaper)
    - `an operator retry of an uncertain recipient that then sends moves the row to sent and moves sent_at`
    - `a journey step marked sent, failed and skipped is tracked with rule_id and step_index` (ticker `MARK_SQL`)
    - `a step whose snapshot has no channel still marks and is tracked with channel null`
    - `a push recipient rejected by fake FCM is tracked as failed with its reason code and accepted_at null` (`createFakeFcm`)
    - `a crashed journey send is tracked as uncertain` (only if the reclaim path keeps such steps; see "Not verified")
    - `a tracking row never holds a phone, email or token` (fake source with canary values; scan every column of every tracking row for the canaries)
  - `migrate.test.ts`: `0019 backfills a sent recipient and a sent step and is idempotent on a second run`.
  - Purge: `purgeTracking deletes rows older than 400 days and keeps newer ones`.
- [ ] **Step 2: Run** `bun test --isolate src/tracking/status.test.ts`, then `src/tracking/triggers.test.ts`, then `src/db/migrate.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the migration (plpgsql trigger functions, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`), `status.ts`, `purge.ts` and the worker loop.
- [ ] **Step 4: Run** the three files, then `src/campaign/recipients.test.ts`, `src/campaign/operator.test.ts`, `src/engine/ticker.test.ts` and `src/engine/pii.test.ts`, one at a time; expect PASS (existing send behaviour unchanged).
- [ ] **Step 5: Commit** `feat(marketing): record a status per campaign and journey message`. Body: migration 0019 adds the tracking tables and backfills up to 400 days of sends; it runs at startup.

### Task 2: Tracking settings, per-project keys and public URL override

**Files:**
- Create: `packages/marketing/src/tracking/settings.ts`, `packages/marketing/src/tracking/keys.ts`, `packages/marketing/src/api/routes-tracking.ts`
- Modify: `packages/marketing/src/api/server.ts` (register routes), `packages/marketing/src/api/unsubscribe.ts` (`createUnsubscribeUrlRenderer` takes a per-project base), `packages/marketing/src/campaign/dispatch.ts` and `packages/marketing/src/engine/ticker.ts` (warm the settings cache where they prepare a project)
- Test: `packages/marketing/src/tracking/settings.test.ts`, `packages/marketing/src/tracking/keys.test.ts`, `packages/marketing/src/api/routes-tracking.test.ts`

**Interfaces:**
- Consumes: `project_settings.tracking` (Task 1).
- Produces:
  - `zBaseUrl`: string ≤200. Must be an `https:` origin, except `http:` for `localhost` or `127.0.0.1`. No user or password, path `/` or empty, no query or hash. Transformed to `url.origin`.
  - `zTrackingSettings = z.strictObject({ publicUrl: zBaseUrl.nullable(), campaignUrl: zBaseUrl.nullable(), conversionEvent: z.string().trim().min(1).max(200).nullable(), conversionWindowDays: z.number().int().min(1).max(30) })`
  - `DEFAULT_TRACKING_SETTINGS = { publicUrl: null, campaignUrl: null, conversionEvent: null, conversionWindowDays: 7 }`
  - `type TrackingSettings`
  - `getTrackingSettings(sql: Queryable, projectId: string): Promise<TrackingSettings>`: defaults merged, like `getChannelSettings`.
  - `putTrackingSettings(sql: Queryable, projectId: string, settings: TrackingSettings): Promise<TrackingSettings>`: an upsert on `project_settings`.
  - `createTrackingSettingsCache(deps: { sql: Queryable; ttlMs?: number /* 60_000 */; now?: () => number }): { get(projectId: string): Promise<TrackingSettings>; peek(projectId: string): TrackingSettings | undefined }`
  - `keys.ts`:
    - `linkKey(encryptionKey: string, projectId: string): Buffer` (decision 1)
    - `webhookSecret(encryptionKey: string, projectId: string): string` (decision 8)
    - `webhookPath(projectId: string, secret: string): string` returning `/marketing/webhooks/msg91/<projectId>/<secret>`
  - `createUnsubscribeUrlRenderer(cfg, publicUrlFor?: (projectId: string) => string | null | undefined)`: the base is `publicUrlFor(projectId) ?? cfg.publicUrl`. `worker.ts`/`server.ts` pass `(id) => cache.peek(id)?.publicUrl`. `runDispatchCycle`'s prepare step and the ticker's per-project load `await cache.get(projectId)` before rendering, so `peek` is warm.
  - Routes in `routesTracking(deps: { sql: Sql; cfg: MarketingConfig; settings: ReturnType<typeof createTrackingSettingsCache> }): Route[]`:
    - `GET /marketing/tracking-settings` (dashboard auth) → `{ settings: TrackingSettings, effectivePublicUrl: string }`
    - `PUT /marketing/tracking-settings` → body `TrackingSettings`, returns the same shape (400 with zod issues)
    - `GET /marketing/tracking-settings/webhook` → `{ url: string }` (`effectivePublicUrl + webhookPath`)

- [ ] **Step 1: Write failing tests.**
  - `settings.test.ts`:
    - `defaults when no row`
    - `zBaseUrl rejects http on a public host, a path, a query, credentials, and keeps the origin of https://campaign.sianext.com/`
    - `a row saved before conversionWindowDays existed reads back with the default`
  - `keys.test.ts`:
    - `link keys differ per project and are stable`
    - `the webhook secret is 43 base64url characters and differs per project`
  - `routes-tracking.test.ts`:
    - `PUT then GET returns the saved settings and effectivePublicUrl falls back to MARKETING_PUBLIC_URL`
    - `the webhook url uses the project's publicUrl when set`
    - `an unsubscribe link of a project with publicUrl set uses it within the cache ttl`
- [ ] **Step 2: Run** `bun test --isolate src/tracking/settings.test.ts`, then `src/tracking/keys.test.ts`, then `src/api/routes-tracking.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the files and wiring.
- [ ] **Step 4: Run** the three files, `src/api/routes.test.ts` and `src/campaign/dispatch.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): tracking settings for public url, campaign url and conversion`.

### Task 3: Signed link tokens and link rewriting in push and email

**Files:**
- Create: `packages/marketing/src/tracking/token.ts`, `packages/marketing/src/tracking/links.ts`
- Modify: `packages/marketing/src/campaign/dispatch.ts` (register links once per campaign in prepare, rewrite per recipient where `BatchItem.message` is built, inline messages only), `packages/marketing/src/engine/ticker.ts` (`deliver`: rewrite before `adapter.send`)
- Test: `packages/marketing/src/tracking/token.test.ts`, `packages/marketing/src/tracking/links.test.ts`, `packages/marketing/src/campaign/dispatch.test.ts`, `packages/marketing/src/engine/ticker.test.ts`

**Interfaces:**
- Consumes: `linkKey` (Task 2), `TrackingSettings.campaignUrl` via the cache (Task 2), `tracked_links` (Task 1), Phase 3 ticker `render` and the email `text` field.
- Produces:
  - `token.ts`:
    - `LINK_TOKEN_TTL_DAYS = 90`, `MAX_TOKEN_LENGTH = 512`
    - `interface LinkTarget { sourceRef: string; linkId: string; expiresAt: Date }`
    - `sealLinkToken(key: Buffer, projectId: string, target: LinkTarget): string`
    - `openLinkToken(keyFor: (projectId: string) => Buffer, token: string, now: Date): { ok: true; projectId: string; target: LinkTarget } | { ok: false; reason: 'invalid' | 'expired' }`
    - The project id is `[A-Za-z0-9_-]{1,64}`. A wrong length, bad base64, a tag failure or a bad JSON shape is `invalid`. Expiry is checked only after the tag verifies.
  - `links.ts`:
    - `MAX_TRACKED_LINKS = 20`
    - `interface TrackableLink { raw: string /* attribute text as in the template */; url: string /* decoded */ }`
    - `extractTrackableLinks(channel: CampaignChannel, template: { body: string; text?: string; link?: string }): TrackableLink[]`. Email: `href="…"` values in `body` that start with `http://` or `https://` and contain no `{{`, entity-decoded for `url`. Push: `link` when http(s) and free of `{{`. Every other channel: `[]`. Deduped, at most `MAX_TRACKED_LINKS`.
    - `registerLinks(sql: Queryable, projectId: string, links: TrackableLink[]): Promise<Map<string /* raw */, string /* linkId */>>`. One `INSERT … ON CONFLICT (project_id, md5(url)) DO UPDATE SET url = EXCLUDED.url RETURNING id, url`, with a process LRU of 5,000 entries keyed `projectId + url`.
    - `trackedUrl(campaignUrl: string, token: string): string` returning `${campaignUrl}/marketing/r/${token}`.
    - `rewriteMessageLinks(message: RenderedMessage, links: ReadonlyMap<string, string>, urlFor: (linkId: string) => string): RenderedMessage`. It replaces `href="<raw>"` in `body`, exact URL occurrences in `text`, and `data.link` when it equals a registered raw. Other fields are untouched.
  - A link whose token would exceed `MAX_TOKEN_LENGTH` (a very long profile id) is sent unchanged. Test: `a token over 512 characters leaves that link unchanged`.
  - Rule in both send paths: rewrite only when `campaignUrl` is set and the links map is not empty. `sourceRef` comes from `ledgerRef`. `expiresAt = now + LINK_TOKEN_TTL_DAYS`. Test sends are never rewritten.

- [ ] **Step 1: Write failing tests.**
  - `token.test.ts`:
    - `seal then open returns the target`
    - `a flipped byte anywhere is invalid`
    - `a token sealed for project A with B's prefix is invalid`
    - `an expired token is expired only when its tag verifies`
    - `the token text contains neither the source ref, the profile id nor the link id` (substring check)
    - `a 513-character token is invalid without decrypting`
  - `links.test.ts`:
    - `an href with {{profile.x}} is not tracked`
    - `a sia:// push link is not tracked`
    - `sms and whatsapp templates yield no links`
    - `&amp; in an href is decoded in url and kept in raw`
    - `21 links keep the first 20`
    - `registering the same url twice returns the same id`
    - `rewrite replaces body href, text url and data.link and nothing else`
  - `dispatch.test.ts`: `a push campaign with campaignUrl set sends data.link as a redirect whose token opens to campaign:<id>:<profile>`; `without campaignUrl the link is unchanged`.
  - `ticker.test.ts`: `an email journey step's button link is rewritten and the plain-text url too`.
- [ ] **Step 2: Run** `bun test --isolate src/tracking/token.test.ts`, then `src/tracking/links.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** with `node:crypto` (`createCipheriv('aes-256-gcm')`, 12-byte random iv) and the two hooks.
- [ ] **Step 4: Run** the four files one at a time, then `src/engine/pii.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): rewrite push and email links to signed tracked redirects`.

### Task 4: Public redirect endpoint and click recording

**Files:**
- Create: `packages/marketing/src/tracking/redirect.ts`
- Modify: `packages/marketing/src/api/server.ts` (route `GET ^/marketing/r/([A-Za-z0-9_.-]{1,512})$`, same auth kind as the unsubscribe routes)
- Test: `packages/marketing/src/tracking/redirect.test.ts`

**Interfaces:**
- Consumes: `openLinkToken`, `linkKey` (Tasks 2 and 3), `tracked_links`, `message_tracking` (Task 1), `createRateLimiter`.
- Produces:
  - `createRedirectHandler(deps: { sql: Sql; encryptionKey: string; invalidTokenLimiter: RateLimiter; now: () => Date; log: { error(message: string, error: unknown): void } }): (token: string, ip: string) => Promise<Response>`. Order:
    1. Limited IP → 429.
    2. Open the token. If invalid → `take(ip)`, 404 page; if expired → 410 page "This link has expired".
    3. `SELECT url FROM marketing.tracked_links WHERE id = $1 AND project_id = $2`. No row → 404.
    4. Record the click (errors logged without the token): `UPDATE marketing.message_tracking SET clicked_at = $now, accepted_at = COALESCE(accepted_at, sent_at), status = <raise to clicked> WHERE source_ref = $1 AND project_id = $2 AND clicked_at IS NULL`.
    5. Return 302 with `Location: url`.
  - All responses carry the headers of decision 6. Pages are fixed HTML with no token, URL or id in them.

- [ ] **Step 1: Write failing tests** (`redirect.test.ts`, through `createServer` and `fetch`):
  - `a valid token redirects 302 to the stored url and records clicked`
  - `a ?url= query and a forged link id never change the Location` (forged id → 404)
  - `a link id from another project is 404`
  - `a garbage token is 404 and the 31st garbage token from one ip in a window is 429` (server `RATE_LIMIT = 30`)
  - `1,000 clicks on one valid link redirect every time and update the row once` (wrap `sql` in a spy that counts `$executeRawUnsafe`/`$queryRawUnsafe` calls whose SQL starts with `UPDATE marketing.message_tracking` and that report a row changed: exactly 1)
  - `a purged message still redirects`
  - `a click on a converted message keeps status converted and sets clicked_at`
  - `a click write failure still redirects`
  - `responses carry no-store, no-referrer and noindex`
- [ ] **Step 2: Run** `bun test --isolate src/tracking/redirect.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the handler and register the route.
- [ ] **Step 4: Run** the file and `src/api/server-errors.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): signed redirects record clicks without exposing student data`.

### Task 5: MSG91 report parsing and idempotent status updates

**Files:**
- Create: `packages/marketing/src/tracking/msg91-reports.ts`, `packages/marketing/src/tracking/delivery.ts`, `packages/marketing/src/channels/fakes/msg91-reports.ts`, `packages/marketing/src/tracking/fixtures/msg91-sms-report.json`, `packages/marketing/src/tracking/fixtures/msg91-whatsapp-report.json`
- Test: `packages/marketing/src/tracking/msg91-reports.test.ts`, `packages/marketing/src/tracking/delivery.test.ts`

**Interfaces:**
- Consumes: `message_tracking`, `message_status_rank` (Task 1).
- Produces:
  - `type ReportStatus = 'delivered' | 'read' | 'failed'`
  - `interface ParsedReport { requestId: string; number: string /* digits only, memory only */; status: ReportStatus; at: Date; reason: string | null /* 'msg91_<code>' matching ^[a-z0-9_]{1,40}$ */ }`
  - `parseMsg91Reports(body: unknown): { reports: ParsedReport[]; ignored: number }`. Accepts the shapes in "Facts", plus `{ data: string }` (JSON text). Mapping: SMS status `1` → delivered; `2, 9, 16, 17, 25, 26` → failed with `msg91_<status>`; WhatsApp `delivered`, `read`, `failed`. Anything else is counted in `ignored`. A missing or unparseable date is the receive time. Never throws; never returns `desc`.
  - `MAX_REPORTS_PER_CALL = 5000`
  - `interface DeliveryUpdate { sourceRef: string; status: ReportStatus; at: Date; reason: string | null }`
  - `reduceUpdates(updates: DeliveryUpdate[]): DeliveryUpdate[]`: one per `sourceRef`, keeping the highest rank and, for that rank, the earliest `at`. A `read` also carries `delivered`.
  - `applyDeliveryUpdates(sql: Queryable, projectId: string, updates: DeliveryUpdate[]): Promise<number>`: reduce first, then one `UPDATE … FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::text[])` scoped by `project_id = $1` and `status <> 'skipped'`, with the decision 2 rules. Returns the rows changed.
  - Fake builders (test only): `smsReportFor(requestId: string, entries: { phone: string; status: '1' | '2' | '16' }[]): unknown` and `whatsAppReportFor(requestId: string, entries: { phone: string; status: 'delivered' | 'read' | 'failed' }[]): unknown`. They produce the fixture shapes from phones held in the fake's recorded requests.

- [ ] **Step 1: Write failing tests.**
  - `msg91-reports.test.ts`:
    - `the sms fixture parses to delivered and failed with msg91_16`
    - `the whatsapp fixture parses read`
    - `form-encoded data parses`
    - `unknown statuses are ignored and counted`
    - `garbage, null, a string and a 10 MB-shaped array do not throw` (the array is capped by the route, not here)
    - `desc text never appears in the output`
  - `delivery.test.ts` (Review Focus 1):
    - `the same delivered report applied twice changes the row once`
    - `read then delivered leaves read with delivered_at = read time`
    - `failed after delivered leaves delivered and failed_at null`
    - `delivered after a provider failure raises to delivered and keeps failed_at`
    - `delivered for an uncertain row sets accepted_at`
    - `two reports for one row in one call apply the furthest`
    - `a report for another project's source_ref changes nothing`
    - `a skipped row is never updated`
- [ ] **Step 2: Run** `bun test --isolate src/tracking/msg91-reports.test.ts`, then `src/tracking/delivery.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): read msg91 delivery reports and update message status idempotently`.

### Task 6: MSG91 webhook endpoint and report matching

**Files:**
- Create: `packages/marketing/src/tracking/report-matcher.ts`, `packages/marketing/src/tracking/webhook.ts`
- Modify: `packages/marketing/src/api/server.ts` (route `POST ^/marketing/webhooks/msg91/([A-Za-z0-9_-]{1,64})/([A-Za-z0-9_-]{43})$`), `packages/marketing/src/engine/pii.test.ts`
- Test: `packages/marketing/src/tracking/report-matcher.test.ts`, `packages/marketing/src/tracking/webhook.test.ts`, `packages/marketing/src/tracking/webhook.load.test.ts`

**Interfaces:**
- Consumes: `parseMsg91Reports`, `applyDeliveryUpdates`, the fake builders (Task 5), `webhookSecret` (Task 2), `SourceResolver.forProject(projectId).lookup(ids, channel)`, `MAX_LOOKUP_IDS`.
- Produces:
  - `createReportMatcher(deps: { sql: Queryable; sources: SourceResolver; ttlMs?: number /* 15 min */; maxRequests?: number /* 2000 */; now?: () => number }): { match(projectId: string, reports: ParsedReport[]): Promise<{ updates: DeliveryUpdate[]; unmatched: number }> }`
    - Groups by `requestId`, loads `source_ref, profile_id, channel` for `(project_id, provider_ref)`, and looks the students up in chunks of `MAX_LOOKUP_IDS`.
    - Builds `Map<sha256(last 10 digits), sourceRef>` from `entry.phone` (decision 1). Numbers shorter than 10 digits never match.
    - Caches non-empty maps per `projectId:requestId`, with in-flight promise sharing. An empty row set is not cached; those reports go to the early-report hold of decision 1 (`HOLD_MS = 120_000`, `HOLD_RETRY_MS = 10_000`, `MAX_HELD_REPORTS = 10_000`).
    - A lookup error propagates.
    - Produces also `matcher.flushHeld(): Promise<number>`, called by a 10 s timer in `worker.ts` and directly by tests.
  - `createMsg91WebhookHandler(deps: { matcher; sql: Sql; encryptionKey: string; failedAuthLimiter: RateLimiter; log }): (projectId: string, secret: string, request: Request, ip: string) => Promise<Response>`. Steps and responses:
    1. Limited IP → 429.
    2. Constant-time secret compare. Wrong → `take(ip)`, 401.
    3. Body over 512 KiB → 413.
    4. JSON, or form-encoded with a `data` field.
    5. Over `MAX_REPORTS_PER_CALL` → 413.
    6. Match and apply, then 200 `{ applied, unmatched, ignored }`.
    - Unparseable body → 200 with zeros, logged as `msg91 report unparseable` with no content.
    - Source failure → 503 `{ error: 'source_unavailable' }`.
    - The path and body are never logged; error logs use the route name.

- [ ] **Step 1: Write failing tests.**
  - `report-matcher.test.ts`:
    - `reports for 3 of 100 phones in one batch match exactly those rows`
    - `a number with a country code matches a stored 10-digit phone and vice versa`
    - `a second call for the same request id makes no lookup`
    - `concurrent calls for one request id share one lookup`
    - `a phone no longer returned by the source is unmatched`
    - `a report that arrives before the mark commits is held and applied by flushHeld once the row exists`: report first, then mark the recipient sent with that provider_ref, then `flushHeld`, and the row is delivered. The empty lookup was not cached.
    - `held reports past HOLD_MS are dropped and counted`
    - `a 9-digit number never matches`
    - `two concurrent calls with the same reports in different orders both succeed` (no deadlock)
  - `webhook.test.ts` (Review Focus 2), end to end with `startFakeMsg91`: send an SMS campaign of 250 recipients, build reports with `smsReportFor` from the fake's requests, POST them over HTTP. Cases:
    - `the rows become delivered`
    - `a wrong secret is 401 and writes nothing`
    - `project A's secret on project B's path is 401`
    - `a valid secret for B cannot change A's rows`
    - `the 31st failed auth from one ip is 429`
    - `a 600 KiB body is 413`
    - `a lookup failure is 503 and a retry then applies`
    - `the secret and the body appear in no log line` (capture the logger)
  - `webhook.load.test.ts` (Review Focus 5): seed 20,000 tracking rows over 200 request ids with a fake source that counts lookups. Call the handler in process 20,000 times with one report each, 50 at a time. Expect `lookups <= 200`, 20,000 rows `delivered` and no 5xx. Do not assert a duration.
  - `pii.test.ts`: `a delivery report for the canary student stores no phone-derived value` (scan the tracking tables and Redis keys for the canary digits and their last 10 digits).
- [ ] **Step 2: Run** `bun test --isolate src/tracking/report-matcher.test.ts`, then `src/tracking/webhook.test.ts`, then `src/tracking/webhook.load.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the matcher, the handler and the route.
- [ ] **Step 4: Run** the three files and `src/engine/pii.test.ts`, one at a time; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): msg91 delivery webhook marks messages delivered, read or failed`.

### Task 7: Conversion attribution from the app-open event

**Files:**
- Create: `packages/marketing/src/tracking/conversions.ts`
- Modify: `packages/marketing/src/kafka/consumer.ts` (`createBatchHandler` deps gain `conversions`), `packages/marketing/src/worker.ts` (wire it)
- Test: `packages/marketing/src/tracking/conversions.test.ts`, `packages/marketing/src/kafka/consumer.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, the `message_tracking` partial index (Task 1), `TrackingSettings` (Task 2).
- Produces:
  - `MAX_EVENT_CLOCK_SKEW_MS = 5 * 60_000`
  - `createConversionRecorder(deps: { sql: Queryable; now: () => Date; ttlMs?: number /* 60_000 */ }): { record(events: NormalizedEvent[]): Promise<number> }`
    - Loads `project_id, tracking` for every project whose `tracking->>'conversionEvent'` is set, refreshed per TTL.
    - Keeps events whose `name` equals that project's event and whose `time <= now + skew`.
    - Runs one statement: `unnest` of `(project_id, profile_id, at, window_days)`, then a `LATERAL` pick of the latest eligible message per event, `ORDER BY sent_at DESC, source_ref DESC LIMIT 1`. Eligible means `accepted_at IS NOT NULL AND status <> 'failed' AND sent_at <= at AND at < sent_at + window`. It then takes `min(at)` per chosen `source_ref` and updates `status = <raise to converted>, converted_at = COALESCE(converted_at, at)` where `converted_at IS NULL`.
    - Returns the rows changed.
  - `createBatchHandler(deps & { conversions: { record(events: NormalizedEvent[]): Promise<number> } })`: calls `conversions.record(candidates)` before the interest filter, inside the same transient-retry loop as `write`. A non-transient error throws (the batch replays; recording is idempotent).

- [ ] **Step 1: Write failing tests.**
  - `conversions.test.ts` (Review Focus 4):
    - `an app open 2 days after a delivered message converts it`
    - `a second app open converts nothing more`
    - `an app open before the message or after the window converts nothing`
    - `with an older delivered and a newer sent message the newer one converts`
    - `a newer provider-failed message is passed over and the older delivered one converts`
    - `if the latest message is already converted an older one is not credited`
    - `replaying the same batch changes nothing`
    - `an event 10 minutes in the future is ignored`
    - `a project without conversionEvent is ignored`
    - `a skipped or send-time failed message is never converted`
    - `two events for one profile in one batch convert once with the earlier time`
  - `consumer.test.ts`: `a conversion event for a profile outside the interest set is recorded and then dropped by the filter`; `a transient conversion error retries the batch`.
- [ ] **Step 2: Run** `bun test --isolate src/tracking/conversions.test.ts`, then `src/kafka/consumer.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** and wire in `worker.ts`.
- [ ] **Step 4: Run** both files and `src/worker.main.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): credit an app open to the student's last message within the window`.

### Task 8: Per-state counters and the reports API

**Files:**
- Create: `packages/marketing/src/tracking/variant-counts.ts`, `packages/marketing/src/tracking/reports.ts`, `packages/marketing/src/api/routes-reports.ts`
- Modify: `packages/marketing/src/journeys/variants.ts` (Phase 3: `MessageChoice` carries `variantKey`), `packages/marketing/src/engine/ticker.ts` (`deliver` counts the outcome), `packages/marketing/src/api/server.ts`
- Test: `packages/marketing/src/tracking/variant-counts.test.ts`, `packages/marketing/src/tracking/reports.test.ts`, `packages/marketing/src/api/routes-reports.test.ts`, `packages/marketing/src/journeys/variants.test.ts`

**Interfaces:**
- Consumes: `message_tracking`, `journey_variant_counts` (Task 1), `getTrackingSettings` (Task 2), Phase 3 `chooseMessage`, `isTimeZone` (`routes-dashboard.ts`).
- Produces:
  - `MessageChoice` becomes `{ ok: true; variantKey: string /* 'default' or the key */; template } | { ok: false; variantKey: string /* '' unless template_not_pinned, then the chosen key */; reason }`.
  - `countVariantOutcome(sql: Queryable, row: { projectId: string; ruleId: string; stepIndex: number; variantKey: string; status: 'sent' | 'skipped' | 'failed'; at: Date }): Promise<void>`: an upsert adding 1 to that column on the UTC day. The ticker calls it after the mark for steps that had a variants definition, best effort (it logs on error, and the send result stands).
  - `reports.ts` types:
    - `type StatusCounts = Record<MessageStatus, number>`
    - `interface Funnel { sent: number /* accepted_at */; delivered: number; read: number; clicked: number; converted: number }`
    - `interface DailyRow { day: string /* YYYY-MM-DD in tz */; sent: number; delivered: number; read: number; clicked: number; converted: number; failed: number; skipped: number; uncertain: number }`. `skipped` and `uncertain` are by `sent_at` with that status; the others are by their milestone timestamp.
    - `NOT_REPORTED: Record<CampaignChannel, ('delivered' | 'read' | 'clicked')[]>` = `{ push: ['delivered','read'], email: ['delivered','read'], sms: ['read','clicked'], whatsapp: ['clicked'], webhook: ['delivered','read','clicked'] }`
    - `interface CampaignReport { campaignId: string; channel: CampaignChannel; statuses: StatusCounts; funnel: Funnel; daily: DailyRow[]; notReported: ('delivered'|'read'|'clicked')[]; conversion: { event: string | null; windowDays: number } }`
    - `interface JourneyReport { ruleId: string; statuses: StatusCounts; funnel: Funnel; daily: DailyRow[]; steps: { stepIndex: number; channel: string | null; statuses: StatusCounts; funnel: Funnel; notReported: ('delivered'|'read'|'clicked')[] }[]; variants: { stepIndex: number; variantKey: string; sent: number; skipped: number; failed: number }[]; conversion: { event: string | null; windowDays: number } }`
  - Functions:
    - `campaignReport(sql: Queryable, projectId: string, campaignId: string, timeZone: string): Promise<CampaignReport | null>`
    - `journeyReport(sql: Queryable, projectId: string, ruleId: string, timeZone: string): Promise<JourneyReport | null>`
    - `MAX_REPORT_DAYS = 90` (the daily rows cover the 90 most recent days with data). Every query is scoped by `project_id` and uses the `(campaign_id|rule_id, sent_at)` indexes.
  - Routes `routesReports(deps: { sql: Sql }): Route[]`:
    - `GET /marketing/reports/campaigns/:id?tz=`
    - `GET /marketing/reports/journeys/:id?tz=`
    - Dashboard auth; `tz` defaults to `'Asia/Kolkata'`, and an unknown one is 400 `invalid_timezone`. Another project's id or an unknown id is 404.

- [ ] **Step 1: Write failing tests.**
  - `variants.test.ts`: `the choice names the variant key, default, or '' when nothing fits`.
  - `variant-counts.test.ts`: `a TS send and an AP skip land in separate rows with no profile id column`; `a count error does not change the step's status` (make the upsert fail with a closed transaction spy, then assert `steps.status = 'sent'`).
  - `reports.test.ts`:
    - `statuses, funnel and daily match a hand-built set of 12 messages`, covering every status, a click without delivery and a conversion without a click
    - `a send-time failure is not in funnel.sent and a provider failure is`
    - `days are bucketed in the given time zone`
    - `a journey report has per-step funnels and per-variant rows`
    - `a campaign of another project is null`
    - `a report over 20,000 rows returns correct totals`
  - `routes-reports.test.ts`: `GET campaign report 200`; `404 for another project`; `400 invalid_timezone`.
- [ ] **Step 2: Run** each new test file with `bun test --isolate`, one at a time; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four files and `src/engine/ticker.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): campaign and journey reports with per-state counts`.

### Task 9: Dashboard: tracking settings, roles and public pass-through

**Files:**
- Create: `apps/start/src/components/marketing/tracking-settings.ts`, `apps/start/src/components/marketing/tracking-settings-card.tsx`, `apps/start/src/components/marketing/tracking-proxy.ts`, `apps/start/src/routes/marketing.r.$token.tsx`, `apps/start/src/routes/marketing.webhooks.msg91.$.tsx`
- Modify: `apps/start/src/components/marketing/channels-page.tsx` (render the card), `apps/start/src/components/marketing/proxy.ts` (role table), `apps/start/src/components/marketing/contract.ts` (types below the identical block)
- Test: `apps/start/src/components/marketing/tracking-settings.test.ts`, `apps/start/src/components/marketing/tracking-proxy.test.ts`, `apps/start/src/components/marketing/proxy.test.ts`

**Interfaces:**
- Consumes: the Task 2 routes, the Task 4 and Task 6 public paths.
- Produces:
  - `tracking-settings.ts`:
    - A zod copy of `zTrackingSettings`.
    - `trackingProblems(form: TrackingForm): { field: keyof TrackingSettings; message: string }[]`, with the same rules as the backend.
    - `exampleTrackedLink(campaignUrl: string | null): string | null` returning `<campaignUrl>/marketing/r/…`.
  - Card copy, one line each, exactly:
    - Public URL: "Where students and providers reach this service: unsubscribe links and the delivery webhook use it. Leave empty to use the server's MARKETING_PUBLIC_URL."
    - Campaign URL: "Links in push and email go through this address so clicks can be counted, for example https://campaign.sianext.com. Leave empty to send links unchanged."
    - Conversion event: "The app event that counts as a conversion, for example the app-open event. Leave empty to turn conversions off."
    - Conversion window: "How many days after a message an app open still counts for it."
    - Webhook (admin only, with a copy button): "Paste this into MSG91's delivery report webhook. Anyone with it can mark messages delivered, so share it only with MSG91."
    - Note: "Changes apply within a minute."
  - `createTrackingProxy(deps: { marketingUrl: () => string | undefined; fetch?: typeof fetch; timeoutMs?: number }): { handle(request: Request): Promise<Response> }`
    - Allows only `GET /marketing/r/<token>` and `POST /marketing/webhooks/msg91/<projectId>/<secret>`; anything else is 404.
    - `redirect: 'manual'`; forwards `x-forwarded-for`.
    - Passes status, `content-type`, `cache-control`, `x-robots-tag`, and `location` only on a 3xx. Fixed `referrer-policy: no-referrer` and `x-content-type-options: nosniff`.
    - Webhook body cap 512 KiB (413).
    - Never logs the URL or the body.
  - Proxy roles: `tracking-settings` GET member, PUT admin; `tracking-settings/webhook` GET admin; `reports/campaigns/[^/]+` GET member; `reports/journeys/[^/]+` GET member.

- [ ] **Step 1: Write failing tests.**
  - `tracking-settings.test.ts`: `http on a public host is a problem`; `a path is a problem`; `window 0 and 31 are problems`; `example link uses the campaign url`.
  - `tracking-proxy.test.ts`:
    - `a 302 from upstream passes location`
    - `a 200 never passes location`
    - `an unknown path is 404 without calling upstream`
    - `a 600 KiB webhook body is 413`
    - `x-forwarded-for is forwarded`
    - `GET on the webhook path is 405 or 404`
  - `proxy.test.ts`: `PUT tracking-settings needs admin`; `the webhook url needs admin`; `reports allow a member`.
- [ ] **Step 2: Run** `bunx vitest run src/components/marketing/tracking-settings.test.ts src/components/marketing/tracking-proxy.test.ts src/components/marketing/proxy.test.ts` in `apps/start`; expect FAIL.
- [ ] **Step 3: Implement** the helpers, the card (labelled inputs, explanations as `<p id>` referenced by `aria-describedby`) and the two route files. Run the route generator so `routeTree.gen.ts` is regenerated, not hand-edited.
- [ ] **Step 4: Run** the vitest files and `bun run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): tracking settings and public redirect and webhook paths`.

### Task 10: Dashboard: Results tab reports

**Files:**
- Create: `apps/start/src/components/marketing/report-view.ts`, `apps/start/src/components/marketing/report-charts.tsx`, `apps/start/src/components/marketing/campaign-report.tsx`, `apps/start/src/components/marketing/journey-report.tsx`
- Modify: `apps/start/src/components/marketing/results-page.tsx` (Journeys and Campaigns sections; a row opens its report), `apps/start/src/components/marketing/contract.ts` (report types copied from Task 8, below the identical block)
- Test: `apps/start/src/components/marketing/report-view.test.ts`

**Interfaces:**
- Consumes: `CampaignReport`, `JourneyReport` and `NOT_REPORTED` shapes (Task 8), the existing `results` and campaign list fetches.
- Produces:
  - `report-view.ts`:
    - `funnelSteps(funnel: Funnel, notReported: string[]): { key: string; label: string; count: number | null /* null = not reported */; percentOfSent: number | null }[]`, in order Sent, Delivered, Read, Clicked, Converted.
    - `dailySeries(daily: DailyRow[], statuses: (keyof DailyRow)[]): { day: string; [status: string]: number | string }[]`, which fills missing days with zeros.
    - `variantRows(report: JourneyReport): { stepIndex: number; label: string /* 'Default', the key, or 'No message fitted' */; sent: number; skipped: number; failed: number }[]`.
    - `statusLabel(status: MessageStatus): string`.
  - Report copy under the funnel, exactly: "Sent means the provider accepted the message. A click or an app open can be counted without a delivery report, and a conversion means the student opened the app within N days of their last message, not that the message caused it." (N from `conversion.windowDays`, or "Conversions are off; set the conversion event in Channels." when `event` is null.)
  - Charts use Recharts with the existing dashboard chart tokens. Load the `dataviz` skill before writing chart code. Each chart has a table fallback for screen readers.

- [ ] **Step 1: Write failing tests** (`report-view.test.ts`):
  - `push funnel shows delivered and read as not reported`
  - `percent of sent is null when nothing was sent`
  - `missing days are zero-filled in order`
  - `variant '' is labelled No message fitted and default is labelled Default`
- [ ] **Step 2: Run** `bunx vitest run src/components/marketing/report-view.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the helpers and components. Only ids, counts and masked names are shown; no profile list is added.
- [ ] **Step 4: Run** `bunx vitest run src/components/marketing` and `bun run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): campaign and journey reports in the results tab`.

### Task 11: Guide, upgrade notes and end-to-end verification

**Files:**
- Create: `packages/marketing/src/tracking/tracking.e2e.test.ts`
- Modify: `packages/marketing/docs/GUIDE.md`, `packages/marketing/README.md`, `apps/start/src/components/marketing/guide-page.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - GUIDE section "Tracking and reports":
    - The statuses and their order.
    - What each channel reports (the `NOT_REPORTED` table).
    - How to set the MSG91 delivery webhook (copy the URL from Channels).
    - Pointing the campaign host (for example `campaign.sianext.com`) at the dashboard origin with TLS, so `/marketing/r/*` reaches the pass-through.
    - Conversion rules (decision 9).
    - Retention (400 days, links expire after 90 days).
    - Privacy (no contact data stored; phones are compared in memory).
    - Troubleshooting rows: webhook 401, links unchanged (no campaign URL), 410 links.
  - Upgrade notes in GUIDE and README:
    - No new environment variable.
    - Migration `0019` runs at startup and backfills up to 400 days of sends (may take minutes on a large install).
    - New public paths `/marketing/r/*` and `/marketing/webhooks/msg91/*` on the public origin.
    - Changing `ENCRYPTION_KEY` invalidates every tracked link and the webhook URL.
    - No `openpanel doctor` check is added (fork discipline forbids editing `self-hosting/cli`); stated as a known gap.
  - `tracking.e2e.test.ts` (the spec's Verification):
    - An SMS campaign of 300 recipients to fake MSG91, whose reports are posted to the webhook over HTTP.
    - A push campaign with a link through the redirect to a local fake link target (`Bun.serve` that records hits).
    - An app-open event through `createBatchHandler`.
    - Then `campaignReport` shows the expected funnel, and the fake target got exactly the stored URL.

- [ ] **Step 1: Write** `tracking.e2e.test.ts`; run `bun test --isolate src/tracking/tracking.e2e.test.ts`; expect PASS (all parts exist). Fix only in the owning task's files if it fails.
- [ ] **Step 2: Run the backend suite** one file at a time for `src/tracking/`, `src/campaign/`, `src/engine/`, `src/kafka/` and `src/api/`; then `bunx vitest run src/components/marketing` in `apps/start`; then `bun run typecheck`. Expected: all pass.
- [ ] **Step 3: Browser pass** with the `run` skill. Use the worktree's `$DASHBOARD_URL` with the seeded login, as the owner (admin), as a member and as an outsider:
  - The owner sets the campaign URL and conversion event and sees the webhook URL.
  - The member sees settings read-only and no webhook URL, and opens a campaign and a journey report.
  - The outsider gets 403 on the marketing pages and on `tracking-settings` through the proxy.
  - Take a screenshot of each report and look at it.
  - Open one tracked link from a test campaign in the browser and confirm the redirect.
- [ ] **Step 4: Update** the guide, README and in-app guide page; run `npx ultracite fix` on the touched files.
- [ ] **Step 5: Commit** `docs(marketing): tracking and reports guide and upgrade notes`.

---

## Self-review

- **Spec coverage.**
  - Delivery events: Tasks 1, 5 and 6. FCM results are captured through the Task 1 triggers, and Task 8 shows push delivered and read as not reported.
  - All eight statuses, ids only: Task 1.
  - Links rewritten and signed with a per-project key, tokens expire: Tasks 3 and 4.
  - Read signals from WhatsApp: Task 5. The email open pixel stays a later option.
  - Conversion, last message wins: Task 7.
  - Reports per campaign and per journey, over time, per state, funnel: Tasks 8 and 10.
  - Configurable public and campaign URLs with explanations: Tasks 2 and 9.
  - Privacy: the canaries in Tasks 1 and 6, plus the redirect page and log tests.
  - End-to-end against fake MSG91 and a fake link target, and the browser pass as owner, member and outsider: Task 11.
- **Type consistency.**
  - `MessageStatus` and `MESSAGE_STATUSES` (Task 1) are used in Tasks 5, 8 and 10.
  - `ParsedReport` and `DeliveryUpdate` (Task 5) are used in Task 6.
  - `TrackingSettings` (Task 2) is used in Tasks 3, 7, 8 and 9.
  - `LinkTarget`, `openLinkToken` and `linkKey` (Tasks 2 and 3) are used in Task 4.
  - `CampaignReport`, `JourneyReport` and `NOT_REPORTED` (Task 8) are used in Task 10.
- **Proportion.** No function bodies, only the SQL rules the tests cannot fix by themselves (decisions 2 and 9).

## Questions for the owner (defaults are built unless answered)

1. **App-open event name.** Which event is the app-open event? Default: conversions stay off until it is set in Channels, with a 7-day window.
2. **Per-state breakdown depth.** Phase 3 forbids recording which state variant a student got. The default is aggregate counters only: per step and state you see sent, skipped and failed, and delivered → converted is per step, not per state. The full funnel per state needs the variant key stored on each message row (one column, purged after 400 days). Allow it?
3. **MSG91 payloads.** Please capture one real SMS delivery report and one WhatsApp status webhook body from MSG91, and confirm whether MSG91 retries on a 5xx. The parser is built against documented shapes that were not verified here.
   - Without retries, reports are lost while the audience API is down (503).
   - Reports that come more than 2 minutes before the send is recorded are also lost.
4. **Push links.** Campaign push links with app schemes (`sia://…`) are not tracked.
   - Once a campaign URL is set, an https push link becomes a redirect through the campaign host. The app must open such a link (in a browser or through app links) for the student to arrive. Is that acceptable?
   - Should push links be https links the app opens, so they can be tracked?
