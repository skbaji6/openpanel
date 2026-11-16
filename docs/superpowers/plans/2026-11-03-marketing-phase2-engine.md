# Marketing Phase 2, Plan 2 of 3: Send Engine, Channels and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver campaigns at most once at provider speed: a campaign dispatch lane that leases, looks up, renders and sends through push, email, webhook and two new MSG91 adapters (SMS, WhatsApp), with per-channel settings (concurrency, rate, quiet hours, consent, price, email quota), a frequency-cap ledger shared with journeys, a versioned provider-template registry, test sends, and measured load results.

**Architecture:** Plan 1's `campaign_recipients` rows are the only queue. A separate in-process lane (`src/campaign/dispatch-lane.ts`, own loops and DB budget) claims up to 500 due rows of one running campaign with `FOR UPDATE SKIP LOCKED` and a lease token, calls `/members/lookup` through plan 1's `withCampaignLane`, records skips, then in one transaction re-checks the campaign state, the frequency cap and writes the fenced `sending` mark plus a ledger row, calls a `BatchChannelAdapter`, and writes the final marks and counter deltas in one transaction. A crash between `sending` and the final mark leaves the row to the reaper, which marks it `uncertain` and never resends it. Pacing (global token bucket and per-channel backoff in Redis, quiet hours, email day quota) happens before a claim, so waiting never holds a lease.

**Tech Stack:** Bun, TypeScript, zod, Postgres (plain-SQL migrations, own runner), Redis (Lua token bucket, existing semaphore), nodemailer pool, Bun `fetch` keep-alive, firebase-admin (existing), bun test.

**Spec:** `docs/superpowers/specs/2026-10-28-marketing-platform-design.md`, sections 6.2 (gates, quota, cancel/pause), 6.3, 6.4, 6.5, 8 (Phase 2 send-engine and channel items), 9 (calls 6, 7, 10, 11, 19, 20, 21, 24, 25). Also binding: plan 1 `docs/superpowers/plans/2026-11-03-marketing-phase2-core.md` (its tables and functions are consumed exactly), the Phase 1 plan, every `Ruling:` line in `.superpowers/sdd/2026-11-02-marketing-phase1/progress.md` and `.superpowers/sdd/2026-11-03-marketing-phase2-core/progress.md`, and `packages/marketing/docs/AUDIENCE_CONTRACT.md`.

**Out of scope here:** every dashboard page (plan 3; this plan adds only the proxy role rules), delivery webhooks from providers (phase 4), real provider testing (owner, later), opt-out beyond the shipped email unsubscribe and do-not-contact list, SMS and WhatsApp journey steps (journeys keep `email | webhook | push`).

## Global Constraints

Every task includes these.

- **Fork discipline (from `packages/marketing/AGENTS.md`, binding):** new files only outside `packages/marketing/` and `apps/start/src/components/marketing/`; never modify, rename, move, reformat or delete any other existing file; use only public package surfaces. Files this plugin created (including everything plan 1 added) may be edited. `bun packages/marketing/scripts/check-fork.ts` and `check-rename.ts` pass after every task.
- **No real sends.** No test, script or route in this plan reaches FCM, an SMTP server, MSG91 or any host other than `127.0.0.1`/`localhost`. MSG91 tests use the fake server (Task 8) through the config's `baseUrl`; push uses an injected `MulticastSender`; email uses the fake SMTP server (Task 11).
- **Ids only.** No email, phone, name, device token, rendered body or provider error text is written to any `marketing` table, Redis key or log line. Contact fields live only in one batch's memory. A failure reason is a code (`msg91 <code>`, `fcm <code>`, `smtp <code>`, `http <status>`), never a provider message. Redaction (`redactSecrets`) runs over every caught error with the batch's contact values and the channel secrets.
- **Delivery guarantee:** at most once for campaigns (spec 6.3, call 19). Only a row the current lease token holds in `leased` may become `sending`; only a `sending` row with that token may receive a final mark. Anything that might have reached the provider and has no stated outcome is `uncertain`; it is never resent without the operator's retry.
- **Spec values pinned here:** lookup at most 500 ids; FCM multicast at most 500 tokens; `ratePerSecond` required for `sms`, `whatsapp` and `email`; email `dailyQuota` required; `requireConsent` default off; quiet hours default off; ledger and send-row retention 400 days; one running campaign per project; journeys keep priority on the audience-API cap (plan 1 `withCampaignLane`).
- **Commits.** `<type>(marketing): <subject>`, imperative, lower case, no period. Never `!`, `BREAKING CHANGE:`, `[major]`, `[minor]` or `[release now]`; upgrade impact (migrations 0013 and 0014, new env `MARKETING_CAMPAIGN_CONCURRENCY`) goes in the body. End with the attribution trailer the executing session's system reminder specifies. Never push.
- **Formatting and checks.** `npx ultracite fix <files you changed>` and `bun run typecheck` before each commit.
- **Test environment (Windows, Git Bash, unchanged from plan 1).** `bun test --isolate` from `packages/marketing` with `MARKETING_ALLOW_RESET=1`, `DATABASE_URL` on a database whose name ends in `_test`, `REDIS_URL` on db index 6; containers are compose project `nudge` (`docker compose -p nudge up -d op-db op-kv op-rp`). Stop local dev processes before moving files. Strip `?schema=public` from a Prisma URL. Spawn children with `process.execPath`. Rerun `db/client.test.ts` alone before treating a cold-start timeout as a failure. Keep `.logs/` and `bash.exe.stackdump` out of commits. Fake servers listen on port 0 and close in `afterAll`.
- **Rulings that bind this plan:** Phase 1 (`SourceBusyError` and `SourceUnavailableError` and `SourceAuthError` never mark anything failed; `SourceAuthError` sets `audience_sources.status = 'source_auth_failed'`; role checks in `proxy.ts` `ALLOWED_ROUTES`, unlisted routes 404; unreachable reasons are the conformance vocabulary; CONTEXT_NO_CONTACT keeps the plugin's `opt_outs`); plan 1 (test sends admin-only, 10 per campaign per hour; a paused campaign holds the project slot; `missed` terminal).

## Review Focus

1. A wrong, rotated or revoked MSG91 auth key (401/403) or a missing FCM/SMTP credential discovered mid-campaign. Expected: the batch returns to `pending`, the campaign shows `dispatchError = 'channel_auth_failed'` and retries every 60 s, nothing is marked `failed`, and it resumes once the credential is fixed (Tasks 9, 10, 13).
2. One malformed phone number in a 100-recipient MSG91 request makes the provider reject the whole request with a 400. Expected: because a 400 means nothing was accepted, the adapter bisects and resends the halves, so only the offending recipient ends `failed` (Tasks 9, 10).
3. A trait used in a WhatsApp parameter is empty or contains a newline, a tab or four or more spaces (Meta rejects the whole request for those). Expected: whitespace is normalised to single spaces; an empty value fails only that recipient with `missing_variable` before any call (Task 4).
4. An MSG91 or SMTP error body quotes the phone number, email or auth key. Expected: neither the `reason` column, a log line nor an exception message contains it (Tasks 9, 10, 11, 19).
5. Quiet hours that cross midnight (21:00 to 08:00 Asia/Kolkata) and an email quota day that ends at local midnight, not UTC midnight. Expected: dispatch pauses at 21:00 local and resumes at 08:00 local; a spread campaign resumes at 00:00 in `quotaTimezone` (Task 6).

---

### Task 1: Schema for settings, templates, ledger and dispatch

**Files:**
- Create: `packages/marketing/migrations/0013_channel_settings_templates.sql`, `packages/marketing/migrations/0014_send_ledger_dispatch.sql`, `packages/marketing/src/campaign/schema-dispatch.test.ts`
- Modify: `packages/marketing/src/db/test-helpers.ts` (`resetMarketingTables` truncates the new tables)

**Interfaces:**
- Produces (schema `marketing`, `IF NOT EXISTS` like 0007 to 0012):
  - `channel_settings(project_id text, channel text CHECK (channel IN ('push','whatsapp','sms','email','webhook')), settings jsonb NOT NULL, version int NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, channel))`.
  - `message_templates(id uuid PK, project_id text NOT NULL, channel text NOT NULL CHECK (channel IN ('sms','whatsapp')), enabled boolean NOT NULL DEFAULT true, current_version int NOT NULL, created_by text NOT NULL, created_at, updated_at)`; index `(project_id, channel)`.
  - `message_template_versions(template_id uuid REFERENCES message_templates ON DELETE CASCADE, version int, display_name text NOT NULL, category text NOT NULL CHECK (category IN ('promotional','service')), provider_ref jsonb NOT NULL, approved_text text NOT NULL, variables jsonb NOT NULL, created_by text NOT NULL, created_at, PRIMARY KEY (template_id, version))` (immutable rows).
  - `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_version int NULL, dispatch_retry_at timestamptz NULL, dispatch_error text NULL, dispatch_failures int NOT NULL DEFAULT 0`; index `campaigns_dispatch_idx (dispatch_retry_at) WHERE state = 'running' AND materialize_state = 'done'`.
  - `send_ledger(source_ref text PK, project_id text NOT NULL, profile_id text NOT NULL, channel text NOT NULL, sent_at timestamptz NOT NULL)`; indexes `send_ledger_person_idx (project_id, profile_id, sent_at) INCLUDE (channel)`, `send_ledger_channel_day_idx (project_id, channel, sent_at)`, `send_ledger_sent_at_idx (sent_at)`. `source_ref` is `campaign:<campaignId>:<profileId>` or `step:<enrollmentId>:<stepIndex>`.
  - `ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS lease_token uuid NULL`; index `campaign_recipients_token_idx (lease_token) WHERE lease_token IS NOT NULL`.
  - `ALTER TABLE campaign_test_sends ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL, provider_ref text NULL`.

- [ ] **Step 1: Write the failing tests** in `schema-dispatch.test.ts`: `a second version row with the same (template_id, version) violates the primary key`; `a template channel 'push' is rejected`; `send_ledger source_ref is unique`; `EXPLAIN of the cap count (project_id = $1 AND profile_id = ANY($2) AND sent_at > $3) over 200,000 ledger rows uses send_ledger_person_idx` (`ANALYZE` first); `EXPLAIN of the day count (project_id, channel, sent_at range) uses send_ledger_channel_day_idx`; `campaign columns template_version, dispatch_retry_at, dispatch_error, dispatch_failures exist with their defaults`; `running migrate() twice is a no-op`.
- [ ] **Step 2: Run** `bun test src/campaign/schema-dispatch.test.ts`; expect FAIL.
- [ ] **Step 3: Write** both migrations and extend `resetMarketingTables`.
- [ ] **Step 4: Run** the test file and `src/db/migrate.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): tables for channel settings, templates and the send ledger` (body: migrations 0013 and 0014 run at startup).

---

### Task 2: Channel settings model, store and routes

**Files:**
- Create: `packages/marketing/src/channels/settings.ts`, `src/channels/settings.test.ts`, `src/api/routes-channel-settings.ts`, `src/api/routes-channel-settings.test.ts`
- Modify: `src/api/server.ts` (register)

**Interfaces:**
- Consumes: `HH_MM`, `QuietHours` (`src/engine/gates.ts`); `isTimeZone` (exported by plan 1 Task 8); `HttpError`, `parseJsonBody`, `json`.
- Produces in `settings.ts`:
  - `CAMPAIGN_CHANNELS = ['push','whatsapp','sms','email','webhook'] as const`, `type CampaignChannel`.
  - `zChannelSettings = z.strictObject({ concurrency: int 1..200, ratePerSecond: number > 0 and ≤ 10,000 | null, quietHours: z.strictObject({ enabled: boolean, start: HH_MM, end: HH_MM, timezone: known zone ≤ 64 chars }), requireConsent: boolean, pricePerMessage: z.strictObject({ amount: number ≥ 0 ≤ 1,000, currency: /^[A-Z]{3}$/ }) | null, dailyQuota: int 1..10,000,000 | null, quotaTimezone: known zone })`, `type ChannelSettings`.
  - `DEFAULT_CHANNEL_SETTINGS: Record<CampaignChannel, ChannelSettings>`: concurrency push 10, email 5, sms 4, whatsapp 4, webhook 10; `ratePerSecond` null; `quietHours {enabled: false, start: '21:00', end: '08:00', timezone: 'Asia/Kolkata'}`; `requireConsent` false; `pricePerMessage` null; `dailyQuota` null; `quotaTimezone` 'Asia/Kolkata'.
  - `checkChannelSettings(channel: CampaignChannel, settings: ChannelSettings): string[]` (issue codes, empty when valid): `rate_required` (sms, whatsapp, email with null rate), `quota_required` (email with null quota), `consent_not_supported` (`requireConsent` true on push, email or webhook: the contract only carries `consent.whatsapp` and `consent.sms_promotional`), `quota_not_supported` (non-email with a quota).
  - `getChannelSettings(sql: Queryable, projectId: string, channel: CampaignChannel): Promise<{ settings: ChannelSettings; version: number; configured: boolean }>` (defaults with version 0 when no row).
  - `putChannelSettings(sql, projectId, channel, settings, expectedVersion: number): Promise<{ settings; version }>` (insert when `expectedVersion` 0, else fenced update; mismatch `409 version_conflict`).
  - `effectiveQuietHours(channel: ChannelSettings['quietHours'], override: { enabled: boolean; start?: string; end?: string; timezone?: string } | null): QuietHours | null` (override null → channel's when enabled; override `enabled: false` → null; override enabled → missing fields filled from the channel's).
- Produces routes (`auth: 'dashboard'`): `GET /marketing/channels/:channel/settings` → `{ channel, settings, version, configured, issues: string[] }`; `PUT /marketing/channels/:channel/settings` body `{ settings: ChannelSettings, expectedVersion: number }` → same shape. `:channel` is one of `CAMPAIGN_CHANNELS`. `PUT` saves settings even with `issues` (they block start, not saving) but rejects `consent_not_supported` and `quota_not_supported` with `400 invalid_settings`.

- [ ] **Step 1: Write the failing tests**: settings: `defaults for every channel parse`; `sms with ratePerSecond null reports rate_required`; `email needs dailyQuota and ratePerSecond`; `requireConsent on push is consent_not_supported`; `an unknown timezone and 24:00 are rejected`; `effectiveQuietHours: null override uses the channel's when enabled, none when disabled`; `override enabled with only start inherits end and timezone`; `override enabled false disables channel quiet hours`. Routes: `GET before any PUT returns defaults, version 0, configured false`; `PUT then GET round-trips with version 1`; `a stale expectedVersion is 409 version_conflict`; `PUT with an unknown field is 400`; `GET /marketing/channels/fax/settings is 404`; `project A cannot read project B's settings`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `settings.ts` and the routes.
- [ ] **Step 4: Run** them (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): per-channel concurrency, rate, quiet hours, consent, price and quota settings`.

---

### Task 3: Send ledger and the shared frequency cap

**Files:**
- Create: `packages/marketing/src/engine/ledger.ts`, `src/engine/ledger.test.ts`
- Modify: `src/engine/ticker.ts` (cap count from the ledger; reserve writes, retry and failure delete the ledger row), `src/engine/ticker.test.ts`, `src/api/routes-dashboard.ts` (`zSettings.caps` gains `scope`), `src/worker.ts` (hourly purge), `src/engine/history-purge.test.ts`

**Interfaces:**
- Consumes: `Caps` (`gates.ts`), `PURGE_DEFAULTS` chunking pattern (`engine.ts`), Task 1 table.
- Produces in `ledger.ts`:
  - `LEDGER_RETENTION_DAYS = 400`.
  - `type CapScope = 'channel' | 'all'`; `interface EffectiveCap { max: number; periodSeconds: number; scope: CapScope }`.
  - `effectiveCap(campaignCap: { max: number; periodSeconds: number } | null, projectCaps: { max: number; periodSeconds: number; scope?: CapScope } | null): EffectiveCap | null` (campaign override wins, scope always from the project, default `'channel'`).
  - `ledgerRef = { campaign(campaignId: string, profileId: string): string; step(enrollmentId: string, stepIndex: number): string }`.
  - `recordLedger(tx: Queryable, rows: { sourceRef: string; projectId: string; profileId: string; channel: string; sentAt: Date }[]): Promise<void>` (one `INSERT ... SELECT FROM unnest(...) ON CONFLICT (source_ref) DO UPDATE SET sent_at = EXCLUDED.sent_at`).
  - `deleteLedger(tx: Queryable, sourceRefs: string[]): Promise<void>`.
  - `countRecentSends(tx: Queryable, args: { projectId: string; profileIds: string[]; channel: string | null; since: Date; excludeRefs?: string[] }): Promise<Map<string, number>>` (one grouped query; `channel` null counts every channel).
  - `countChannelSendsSince(tx: Queryable, projectId: string, channel: string, since: Date): Promise<number>` (email day quota).
  - `purgeSendHistory(sql: Sql, retentionDays?: number): Promise<{ ledger: number; recipients: number }>`: chunked like `purgeOldEvents`; deletes ledger rows with `sent_at` older than the retention and `campaign_recipients` rows older than it whose campaign is in a terminal state.
- Journey change in `ticker.ts`: `CAP_COUNT_SQL` is replaced by `countRecentSends` with `excludeRefs = [ledgerRef.step(...)]` and the project's scope; the existing per-profile advisory lock stays; `RESERVE_SQL` and `recordLedger` run in the same transaction; a step marked `failed` or requeued (`step.retry`) deletes its ledger row; a step marked `sent` keeps it; `skipped` never writes one. The journey skip reason stays `cap`.
- `zSettings.caps` becomes `{ max, periodSeconds, scope?: 'channel' | 'all' }` (absent means `'channel'`, the shipped behaviour).

- [ ] **Step 1: Write the failing tests**: ledger: `countRecentSends counts sent and uncertain-held rows inside the window and not older ones`; `channel null counts every channel, a channel counts only that one`; `excludeRefs leaves out the caller's own row`; `recordLedger twice for one ref keeps one row with the later time`; `effectiveCap prefers the campaign's max and period and keeps the project scope`; `purgeSendHistory removes a 401-day-old ledger row and a 401-day-old recipient of a completed campaign, keeps a 399-day row and keeps recipients of a running campaign`. Ticker: `a journey push step reserving under cap writes a ledger row`; `a campaign ledger row counts against a journey cap of 1 per day on push` (insert a `campaign:` ledger row, expect the step skipped with `cap`); `scope all counts an email send against a push step`; `a requeued step deletes its ledger row`; existing cap tests stay green.
- [ ] **Step 2: Run** `bun test src/engine/ledger.test.ts src/engine/ticker.test.ts src/engine/history-purge.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `ledger.ts`, the ticker change and the `every(PURGE_INTERVAL_MS, 'purge send history', ...)` job.
- [ ] **Step 4: Run** them and the package suite (PASS).
- [ ] **Step 5: Commit** `feat(marketing): frequency cap shared by journeys and campaigns` (body: caps gain an optional `scope`; send history older than 400 days is purged hourly).

---

### Task 4: Template registry store and strict provider renderer

**Files:**
- Create: `packages/marketing/src/templates/registry.ts`, `src/templates/registry.test.ts`, `src/templates/provider-render.ts`, `src/templates/provider-render.test.ts`

**Interfaces:**
- Consumes: `renderTemplate(template, vars, { mode: 'text' })` (`src/template/render.ts`); Task 1 tables; `HttpError`.
- Produces in `registry.ts`:
  - `zSmsProviderRef = z.strictObject({ flowId: /^[A-Za-z0-9]{1,64}$/, senderId: /^[A-Z]{6}$/ optional })`; `zWhatsAppProviderRef = z.strictObject({ templateName: /^[a-z0-9_]{1,512}$/, namespace: /^[A-Za-z0-9_-]{1,128}$/, language: /^[a-z]{2,3}(_[A-Z]{2})?$/, integratedNumber: /^[0-9]{8,15}$/ optional })`.
  - `zTemplateVariable = z.strictObject({ slot: string, value: string ≤ 500 })` where `slot` is `/^[A-Za-z][A-Za-z0-9_]{0,29}$/` for sms (the flow's variable name, for example `var1`) and `/^(header|body)_[1-9][0-9]?$/` for whatsapp; `value` is template text whose only placeholders are `{{profile.<trait>}}`.
  - `zTemplateInput = z.strictObject({ channel: 'sms' | 'whatsapp', displayName: 1..200, category: 'promotional' | 'service', providerRef, approvedText: 1..4096, variables: zTemplateVariable[] (max 20, unique slots) })` with `providerRef` checked against the channel.
  - `interface TemplateVersion { templateId; version; displayName; category; providerRef; approvedText; variables: { slot: string; value: string }[]; createdBy; createdAt }`; `interface TemplateRow extends TemplateVersion { projectId; channel; enabled: boolean; currentVersion: number; updatedAt }`.
  - `createTemplateRegistry(deps: { sql: Sql; now: () => Date })` returning `list(projectId, channel?: 'sms' | 'whatsapp'): Promise<TemplateRow[]>`, `get(projectId, id): Promise<TemplateRow>`, `getVersion(projectId, id, version): Promise<TemplateVersion>`, `create(ctx: { projectId; userId }, input): Promise<TemplateRow>`, `update(ctx, id, input, expectedVersion: number): Promise<TemplateRow>` (inserts version `current_version + 1`; the channel cannot change, `400 channel_immutable`), `setEnabled(ctx, id, enabled: boolean): Promise<TemplateRow>`, `readiness(projectId, id): Promise<{ ok: true; version: TemplateVersion; channel } | { ok: false; code: 'template_not_found' | 'template_disabled' | 'template_mapping_missing' }>`.
  - Validation code `400 mapping_mismatch`: for whatsapp every `{{n}}` in `approvedText` needs a `body_n` slot and no `body_n` may exist without its `{{n}}`; header slots are not checked against the text (the approved text holds the body only). For sms no text check (DLT text uses `{#var#}` without names). `template_mapping_missing` (readiness) is a whatsapp version whose body placeholders lack slots (possible only for rows edited outside the API).
- Produces in `provider-render.ts`: `renderProviderVariables(version: TemplateVersion, traits: Record<string, string | number | boolean>): { ok: true; variables: { slot: string; value: string }[] } | { ok: false; reason: 'missing_variable' }`. Each value is rendered with `renderTemplate(..., { mode: 'text' })` and `profile = traits`; a missing trait, or a value that is empty after normalisation, is `missing_variable`; normalisation replaces every run of whitespace (including `\n`, `\t`, U+2028) with one space and trims, so no value contains a newline, a tab or four consecutive spaces; values longer than 1,024 characters are cut to 1,024. Variables come out in slot order (`header_*` before `body_*`, then by number; sms by the order given).

- [ ] **Step 1: Write the failing tests**: registry: `create stores version 1 enabled`; `update creates version 2 and getVersion(1) still returns the old text`; `a stale expectedVersion is version_conflict`; `whatsapp text with {{1}} {{2}} and only body_1 is mapping_mismatch`; `a body_3 without {{3}} is mapping_mismatch`; `an sms slot 'var-1' and a whatsapp slot 'body_0' are rejected`; `a value with {{event.x}} is rejected`; `readiness of a disabled template is template_disabled`; `another project's template is not_found`; `changing channel is channel_immutable`. Renderer: `fills body_1 from {{profile.firstName}}`; `a missing trait is missing_variable`; `a value 'A\nB\t\tC     D' renders 'A B C D'`; `a trait of only spaces is missing_variable`; `slots come out header_1, body_1, body_2, body_10`; `a 2,000-character trait is cut to 1,024`; `a trait that looks like {{profile.x}} is not re-expanded`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): versioned registry for DLT and Meta approved templates`.

---

### Task 5: Template routes and the campaign readiness hooks

**Files:**
- Create: `packages/marketing/src/api/routes-templates.ts`, `src/api/routes-templates.test.ts`, `src/campaign/channel-ready.ts`, `src/campaign/channel-ready.test.ts`
- Modify: `src/campaign/service.ts`, `src/campaign/service.test.ts`, `src/campaign/scheduler.ts`, `src/campaign/scheduler.test.ts` (plan 1 files), `src/api/server.ts`, `src/worker.ts`

**Interfaces:**
- Consumes: Task 2 `getChannelSettings`, `checkChannelSettings`; Task 4 registry; plan 1 `createCampaignService` (`channelReady` hook), `runScheduleTick`; `marketing.channel_configs`.
- Produces in `channel-ready.ts`:
  - `createChannelReady(deps: { sql: Sql; registry: ReturnType<typeof createTemplateRegistry> }): (projectId: string, channel: string, template: unknown) => Promise<string | null>` returning, first match wins: `channel_not_configured` (no `channel_configs` row), the first `checkChannelSettings` issue (`rate_required`, `quota_required`), for sms and whatsapp the registry readiness code (`template_not_found`, `template_disabled`, `template_mapping_missing`) and `template_channel_mismatch`; else null.
  - `pinTemplate(tx: Queryable, projectId: string, channel: string, template: unknown): Promise<number | null>`: for sms and whatsapp reads `current_version` of an enabled template of that channel with `FOR SHARE` and returns it; null when not pinnable; for other channels returns 0.
- Plan 1 changes: `createCampaignService` deps gain `pinTemplate?: typeof pinTemplate`; `start` (the path that moves to `running`) and the scheduler's `claim_due` path call it inside their transaction and write `campaigns.template_version`; null makes `start` answer `409` with the readiness code; in the scheduler, null fails the campaign inside the scheduler's own transaction: run the `claim_due` `START` update first, then `failCampaignIn(tx, id, 'template_unavailable', now)` (running → failed). Never call `failCampaign` there: it opens its own transaction on a row the scheduler holds `FOR UPDATE` (it would wait on itself), and `fromStates('fail')` excludes `scheduled`. Do not add a scheduled → failed transition to `state.ts`. The 409 error code of a failed `channelReady` gate is the hook's returned string (plan 1's default `channel_not_ready` remains for a missing hook). A queued `start` (`send_kind = 'now'`) pins when the scheduler starts it.
- Produces routes (`auth: 'dashboard'`): `GET /marketing/templates?channel=sms|whatsapp` → `{ templates: TemplateRow[] }`; `POST /marketing/templates` (body `zTemplateInput`) → `TemplateRow`; `GET /marketing/templates/:id` → `TemplateRow`; `GET /marketing/templates/:id/versions/:version` → `TemplateVersion`; `PUT /marketing/templates/:id` (body `{ ...zTemplateInput, expectedVersion }`) → `TemplateRow`; `POST /marketing/templates/:id/enable` and `/disable` → `TemplateRow`; `POST /marketing/templates/:id/preview` (body `{ version?: number; sample: { profile: Record<string, string | number | boolean> } }`) → `{ ok: true; variables: { slot; value }[]; text: string } | { ok: false; reason: 'missing_variable' }` where `text` is `approvedText` with `{{n}}` replaced by the `body_n` value (whatsapp) or the approved text unchanged (sms). There is no delete (campaigns reference versions).

- [ ] **Step 1: Write the failing tests**: hook: `sms without channel credentials is channel_not_configured`; `sms with credentials but ratePerSecond null is rate_required`; `a disabled template is template_disabled`; `a whatsapp template id used on an sms campaign is template_channel_mismatch`; `push with credentials is ready`. Service and scheduler (extend plan 1 tests): `start pins template_version to the current version`; `editing the template after start leaves the campaign on its pinned version`; `disabling the template after start does not stop the campaign`; `a scheduled sms campaign whose template was disabled fails with template_unavailable when due`. Routes: `create, update, enable, disable, versions and preview round-trip`; `preview with a missing trait answers ok false`; `a body with an unknown field is 400`; `another project's template is 404`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** the hook, the pinning in `service.ts` and `scheduler.ts`, the routes, and wire `channelReady` and `pinTemplate` in `worker.ts` and `server.ts`.
- [ ] **Step 4: Run** the package suite (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): campaigns start only with an enabled, mapped provider template`.

---

### Task 6: Pacing: global rate, channel backoff, quiet hours and the email day

**Files:**
- Create: `packages/marketing/src/campaign/pacing.ts`, `src/campaign/pacing.test.ts`

**Interfaces:**
- Consumes: `inQuietHours`, `nextAllowedTime` (`gates.ts`); `zonedTimeToUtc` (plan 1); `countChannelSendsSince` (Task 3); Redis.
- Produces:
  - `createRateBucket(redis: Redis, opts: { now?: () => number })` returning `take(key: string, ratePerSecond: number, wanted: number): Promise<{ granted: number; waitMs: number }>`: Redis key `marketing:rate:<key>` (key is `<projectId>:<channel>`), capacity `max(1, ratePerSecond)` (one second of burst), refill continuous; grants `min(wanted, floor(tokens))`, `waitMs` is the time until the next whole token when `granted < wanted`. One Lua script (`HMGET tokens ts`, refill, take, `HMSET`, `PEXPIRE` 60 s) so replicas share the bucket.
  - `acquireTokens(bucket, key, ratePerSecond: number | null, wanted: number, budgetMs: number, sleep: (ms: number) => Promise<void>): Promise<number>`: loops `take` and `sleep(waitMs)` until `wanted` tokens are granted or `budgetMs` would be exceeded; returns the tokens granted (null rate returns `wanted` immediately).
  - `createChannelBackoff(redis: Redis)` returning `set(projectId, channel, ms: number): Promise<void>` (key `marketing:channel-backoff:<projectId>:<channel>`, `PX` = ms, never shortens a longer one), `until(projectId, channel): Promise<number | null>` (epoch ms).
  - `retryAfterMs(header: string | null, fallbackMs = 5000): number` (seconds or HTTP date, clamped to 1,000..60,000).
  - `quotaDayStart(now: Date, timeZone: string): Date` and `nextQuotaDayStart(now: Date, timeZone: string): Date` (local midnight via `zonedTimeToUtc`).
  - `remainingQuota(tx: Queryable, args: { projectId: string; channel: string; dailyQuota: number; quotaTimezone: string; now: Date }): Promise<number>` (`dailyQuota - countChannelSendsSince(dayStart)`, floored at 0).
  - `claimSize(ratePerSecond: number | null): number` = `min(500, ratePerSecond === null ? 500 : max(1, ceil(ratePerSecond * 10)))`, so one batch needs at most about 10 s of tokens.

- [ ] **Step 1: Write the failing tests** (real test Redis, injected clock): `rate 10 grants 10 at once and then 0 with waitMs about 100`; `two bucket clients on one key share the budget` (20 takes of 1 over two clients at rate 10 grant 10 in the first second); `acquireTokens for 25 at rate 10 waits about 1.5 s through the injected sleep`; `acquireTokens stops at budgetMs and returns what it got`; `backoff set 5 s then 1 s keeps 5 s`; `retryAfterMs('120') is 60,000 and a missing header is 5,000`; `quotaDayStart 2026-11-10T20:00Z in Asia/Kolkata is 2026-11-10T18:30Z`; `nextQuotaDayStart across a New York DST change is local midnight`; `remainingQuota counts ledger rows of today only (local day)`; `claimSize(1) is 10, claimSize(100) is 500, claimSize(null) is 500`; quiet hours (pinning Review Focus 5 against `gates.ts`): `21:00 to 08:00 Asia/Kolkata: 15:29Z is outside, 15:30Z is inside, nextAllowedTime from 16:00Z is 02:30Z next day`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `pacing.ts`.
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): shared per-channel rate ceiling, provider backoff and quota day`.

---

### Task 7: Batch adapter interface, result classification and fake FCM

**Files:**
- Create: `packages/marketing/src/channels/batch.ts`, `src/channels/batch.test.ts`, `src/channels/fakes/fcm.ts`
- Modify: `src/channels/types.ts` (`Recipient.phone?: string`; `RenderedMessage.meta` gains the campaign form), `src/channels/webhook.ts`, `src/channels/webhook.test.ts` (campaign payload), `src/channels/registry.ts`, `src/channels/registry.test.ts`

**Interfaces:**
- Consumes: `ChannelAdapter`, `SendResult`, `getAdapter`.
- Produces in `types.ts`: `RenderedMessage.meta` becomes `{ projectId: string; enrollmentId: string; ruleId: string; stepIndex: number } | { projectId: string; campaignId: string }` (journey code unchanged; webhook adds `campaignId` to its payload and omits the journey fields for a campaign).
- Produces in `batch.ts`:
  - `interface BatchItem { profileId: string; to: Recipient; message: RenderedMessage | ProviderMessage; idempotencyKey: string; unsubscribeUrl: string }`; `interface ProviderMessage { kind: 'provider'; version: TemplateVersion; variables: { slot: string; value: string }[] }`.
  - `type DeliveryOutcome = { profileId: string; outcome: 'sent' | 'failed' | 'uncertain' | 'retry' | 'rate_limited' | 'channel_error'; reason?: string; providerRef?: string; invalidTokens?: string[]; retryAfterMs?: number }` (`retry`: certainly not accepted, back to pending; `rate_limited`: 429, back to pending and back off the channel; `channel_error`: credentials rejected, back to pending and back off the campaign).
  - `interface BatchChannelAdapter<C> { id: CampaignChannel; configSchema: z.ZodType<C>; maxBatch: number; sendBatch(items: BatchItem[], config: C, opts: { concurrency: number; signal?: AbortSignal }): Promise<DeliveryOutcome[]> }` (exactly one outcome per item, in any order).
  - `classifySendResult(result: SendResult): Omit<DeliveryOutcome, 'profileId'>`: `ok` → sent; `retryable: false` → failed; reasons `fcm messaging/quota-exceeded`, `fcm messaging/message-rate-exceeded`, `http 429`, `smtp 421`, `smtp 450`, `smtp 451`, `smtp 452` → rate_limited; `fcm app/invalid-credential`, `smtp EAUTH`, `http 401`, `http 403` → channel_error; `smtp ECONNREFUSED`, `smtp EDNS`, `network error` before a connection (the webhook adapter's reason) → retry; every other retryable result (timeouts, resets, 5xx, unknown) → uncertain. `invalidTokens` passes through.
  - `perRecipientBatch<C>(adapter: ChannelAdapter<C>): BatchChannelAdapter<C>` with `maxBatch` 500, running `adapter.send` over the items with `opts.concurrency` in flight and mapping each result through `classifySendResult`; a thrown error is `uncertain` with the redacted reason `exception`.
- Produces in `registry.ts`: `registerBatchAdapter(adapter)`, `getBatchAdapter(channel: CampaignChannel): BatchChannelAdapter<unknown>` (push, email, webhook default to `perRecipientBatch` of the registered adapter), `configSchemaFor(channel: string): z.ZodType<unknown>` (used by the credential routes).
- Produces in `fakes/fcm.ts`: `createFakeFcm(opts: { latencyMs?: number; tokensPerSecond?: number; invalidTokens?: Set<string>; failCode?: () => string | null; sleep?: (ms: number) => Promise<void> }): MulticastSender & { calls: number; delivered: Map<string, number> }` (`delivered` counts per token, so duplicates are visible).

- [ ] **Step 1: Write the failing tests**: `classifySendResult maps each listed reason as above` (table test); `perRecipientBatch with concurrency 3 never has more than 3 sends in flight`; `perRecipientBatch returns one outcome per item when one send throws`; `push through perRecipientBatch with the fake FCM marks a recipient with only invalid tokens failed and returns the invalid tokens`; `fcm messaging/quota-exceeded is rate_limited`; `a campaign webhook payload carries campaignId and no ruleId`; `getBatchAdapter('sms') throws until registered`; `configSchemaFor('push') is the push config schema`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the package suite (PASS; journey tests untouched by the meta union) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): batch channel interface with at-most-once result classes`.

---

### Task 8: Fake MSG91 server

**Files:**
- Create: `packages/marketing/src/channels/fakes/msg91-server.ts`, `src/channels/fakes/msg91-server.test.ts`

**Interfaces:**
- Produces: `startFakeMsg91(opts?: { delayMs?: number }): Promise<{ baseUrl: string; requests: { path: string; authkey: string | null; body: unknown }[]; connections: () => number; script(path: '/api/v5/flow' | '/api/v5/whatsapp/whatsapp-outbound-message/bulk/', responder: (body: unknown, index: number) => { status: number; headers?: Record<string, string>; body: unknown } | 'hang' | 'reset'): void; delivered: Map<string, number>; close(): Promise<void> }>` on `127.0.0.1:0`. Default responders reproduce the shapes read from `sia-backend`: SMS `200 {type: 'success', message: '<request id>'}`; WhatsApp `200 {status: 'success', hasError: false, request_id: '<request id>'}`. `delivered` counts each phone (`recipients[].mobiles` or `to_and_components[].to[]`) the server answered as accepted, so tests can assert no phone got two messages. Helpers exported for scripts: `responses = { rateLimited(retryAfterSeconds), authFailed(), badRequestIfPhone(phone), serverError(), partial(failedPhones: string[]), malformed() }`. `partial` answers WhatsApp `200 {status: 'success', hasError: true, request_id, results: [{ to, status: 'success' | 'failed', error_code? }]}` (the per-recipient shape this plan assumes until the real one is confirmed; see open questions). `connections()` counts accepted TCP connections (keep-alive check). Requests are kept only in memory.

- [ ] **Step 1: Write the failing tests**: `the default SMS response is type success with a request id`; `script with rateLimited(3) answers 429 with Retry-After 3`; `hang never answers and reset closes the socket`; `three sequential fetches with keep-alive use one connection`; `delivered counts a phone once per accepted request`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** with `Bun.serve` (the `connections` count from its `fetch` handler's `server.requestIP` is not enough: count through a `node:net` server proxied to it, or use `node:http` `connection` events).
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `test(marketing): fake MSG91 server with scripted provider responses`.

---

### Task 9: MSG91 SMS adapter

**Files:**
- Create: `packages/marketing/src/channels/msg91-http.ts`, `src/channels/msg91-sms.ts`, `src/channels/msg91-sms.test.ts`
- Modify: `src/channels/registry.ts` (`registerDefaultAdapters` registers it), `src/api/routes-dashboard.ts` (credential routes accept `sms|whatsapp` and use `configSchemaFor`; `PUBLIC_CONFIG_FIELDS.sms = ['baseUrl']`)

**Interfaces:**
- Consumes: Tasks 7, 8; `withSendTimeout`, `SEND_TIMEOUT_MS`; `retryAfterMs` (Task 6); `redactSecrets`.
- Produces in `msg91-http.ts`: `postMsg91(url: string, authKey: string, body: unknown, signal: AbortSignal): Promise<{ kind: 'response'; status: number; json: unknown; retryAfter: string | null } | { kind: 'not_sent' } | { kind: 'unknown' }>` (header `authkey`, `content-type: application/json`, `redirect: 'manual'`, Bun `fetch` keep-alive; a connection refused or DNS failure is `not_sent`; a timeout, reset or unreadable body after the request was written is `unknown`; the response body is parsed and never logged); `MSG91_SMS_BASE_URL = 'https://control.msg91.com'`; `zMsg91BaseUrl` (https, or http only for `127.0.0.1`/`localhost`).
- Produces in `msg91-sms.ts`:
  - `zMsg91SmsConfig = z.strictObject({ authKey: string 8..128, baseUrl: zMsg91BaseUrl optional })`.
  - `MSG91_SMS_MAX_RECIPIENTS = 100` (constant to confirm against MSG91's documentation; see open questions).
  - `createMsg91SmsAdapter(opts?: { timeoutMs?: number }): BatchChannelAdapter<Msg91SmsConfig>` with `id 'sms'`, `maxBatch` 100. Request: `POST <baseUrl>/api/v5/flow` body `{ template_id: flowId, short_url: '0', realTimeResponse: '1', recipients: [{ mobiles: <phone>, <slot>: <value>, ... }], sender?: senderId }`, items in chunks of `maxBatch`, at most `opts.concurrency` chunks in flight.
  - Outcomes per request: `2xx` and `type === 'success'` → every recipient `sent` with `providerRef` = `message` (the request id); `429` → `rate_limited` with `retryAfterMs`; `401`/`403` → `channel_error` reason `msg91 auth`; `400`/`422` with more than one recipient → bisect (algorithm below); `400`/`422` with one recipient → `failed` reason `msg91 <code>` where `code` is `json.code` when it matches `/^[A-Za-z0-9_]{1,32}$/`, else the HTTP status; other `4xx` → `failed`; `5xx`, `2xx` without `type: 'success'`, `unknown` → `uncertain` with `providerRef` set when a request id was readable; `not_sent` → `retry`. An item without `to.phone` is `failed` reason `no_phone` without a call.
  - Bisect (not determined by the signature): on a whole-request `400`/`422` for `n > 1` recipients, split the chunk into halves and send each half as its own request, recursively, so the failing recipients end `failed` and the rest get their own outcome. Stop at depth 7 (100 → 1); requests made by the bisection count against the same timeout budget, and items not sent when the budget runs out are `retry`.

- [ ] **Step 1: Write the failing tests** against the fake server: `250 recipients go out as 100, 100, 50 with the flow id, sender and slot values`; `a success response marks all sent with the request id`; `429 with Retry-After 7 is rate_limited 7,000 ms for every recipient`; `401 is channel_error and no recipient is failed`; `a 400 caused by one bad phone in 100 fails only that phone and sends the other 99 once` (Review Focus 2; assert `delivered`); `a hang past the timeout is uncertain for the whole chunk`; `a reset after the request was written is uncertain`; `a refused connection is retry`; `a 200 with type error is uncertain`; `three chunks over keep-alive use at most concurrency connections`; `an error body echoing the phone and the auth key yields a reason with neither` (Review Focus 4); `PUT /marketing/channels/sms stores the config encrypted and GET masks authKey`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `msg91-http.ts`, the adapter and the route change.
- [ ] **Step 4: Run** them (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): MSG91 SMS channel over the flow API`.

---

### Task 10: MSG91 WhatsApp adapter

**Files:**
- Create: `packages/marketing/src/channels/msg91-whatsapp.ts`, `src/channels/msg91-whatsapp.test.ts`
- Modify: `src/channels/registry.ts`, `src/api/routes-dashboard.ts` (`PUBLIC_CONFIG_FIELDS.whatsapp = ['integratedNumber', 'baseUrl']`)

**Interfaces:**
- Consumes: Task 9 `postMsg91`, `zMsg91BaseUrl`; Tasks 4, 7, 8.
- Produces:
  - `zMsg91WhatsAppConfig = z.strictObject({ authKey: string 8..128, integratedNumber: /^[0-9]{8,15}$/, baseUrl: zMsg91BaseUrl optional })`; `MSG91_WHATSAPP_BASE_URL = 'https://api.msg91.com'`; `MSG91_WHATSAPP_MAX_RECIPIENTS = 100` (to confirm, see open questions).
  - `createMsg91WhatsAppAdapter(opts?: { timeoutMs?: number }): BatchChannelAdapter<Msg91WhatsAppConfig>` with `id 'whatsapp'`. Request: `POST <baseUrl>/api/v5/whatsapp/whatsapp-outbound-message/bulk/` body `{ integrated_number: providerRef.integratedNumber ?? config.integratedNumber, content_type: 'template', payload: { messaging_product: 'whatsapp', type: 'template', template: { name, language: { code: language, policy: 'deterministic' }, namespace, to_and_components: [{ to: [<phone>], components: { <slot>: { type: 'text', value } } }] } } }` with one `to_and_components` entry per recipient (personalised values per recipient in one call). No retries inside the adapter (the `sia-backend` client's `retry(3)` is deliberately not copied: it can send twice).
  - Outcomes: `2xx` with `status === 'success'` (or `type === 'success'`) and `hasError !== true` → all `sent`, `providerRef` = `request_id`; `2xx` with a `results` array → each listed phone `sent` or `failed` (`msg91 <error_code>`), recipients not listed `uncertain`, all with the request id; `429`, `401`/`403`, `400`/`422` (with bisection), `5xx`, `unknown`, `not_sent` exactly as Task 9. Two recipients with the same phone in one request both take that phone's result.

- [ ] **Step 1: Write the failing tests**: `the request carries name, namespace, language with policy deterministic, the integrated number and header_1/body_1 per recipient`; `a template integratedNumber overrides the channel's`; `success marks all sent with request_id`; `a partial response marks listed failures failed, listed successes sent and unlisted recipients uncertain`; `hasError true without results is uncertain`; `429, 401, a one-bad-phone 400 and a hang behave as in the SMS adapter`; `a malformed 200 body is uncertain`; `an error body quoting the phone yields a code-only reason`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): MSG91 WhatsApp channel over the bulk template API`.

---

### Task 11: Pooled email for campaigns and the shared fake SMTP server

**Files:**
- Create: `packages/marketing/src/channels/fakes/smtp-server.ts`, `src/channels/email-pool.test.ts`
- Modify: `src/channels/email.ts` (add `createPooledEmailAdapter`; journeys keep `createEmailAdapter` unchanged), `src/channels/email.test.ts` (use the extracted fake), `src/channels/registry.ts`

**Interfaces:**
- Consumes: `configSchema`, `failureFor`, header-safety helpers already in `email.ts`; Task 7.
- Produces in `fakes/smtp-server.ts`: `startFakeSmtp(opts?: { reply?: (command: string, index: number) => string | null; delayMs?: number }): Promise<{ port: number; messages: { to: string[]; size: number }[]; connections: () => number; close(): Promise<void> }>` (the fake now inlined in `email.test.ts`, extracted; `messages` holds addresses in memory only).
- Produces in `email.ts`: `createPooledEmailAdapter(options?: { createTransport?: ...; timeoutMs?: number; idleCloseMs?: number }): BatchChannelAdapter<EmailConfig>` with `id 'email'`, `maxBatch` 500: one nodemailer transport per `(project, config digest)` per replica with `pool: true`, `maxConnections = opts.concurrency`, `maxMessages: 100`, closed after `idleCloseMs` (default 60,000) of no use. Each message has the same headers as the journey adapter (List-Unsubscribe from `unsubscribeUrl`). Deadline: a send not settled within `timeoutMs` makes the pool close (destroying its sockets) and that item `uncertain`; items not yet handed to the pool are `retry`. Result mapping through `classifySendResult(failureFor(error))`. SMTP command pipelining is not used (nodemailer does not pipeline across messages); reuse of authenticated connections is the gain.

- [ ] **Step 1: Write the failing tests** against the fake SMTP: `200 messages with concurrency 3 use at most 3 connections`; `a 452 reply for one recipient is rate_limited`; `a 550 reply is failed with reason smtp 550`; `EAUTH is channel_error`; `a server that stops answering mid-batch yields uncertain for in-flight items and retry for the rest, and the pool's sockets are closed`; `List-Unsubscribe is present on every message`; the journey email tests still pass on the extracted fake.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the channel tests (PASS).
- [ ] **Step 5: Commit** `feat(marketing): pooled SMTP connections for email campaigns`.

---

### Task 12: Recipient leases, fenced marks and the reaper

**Files:**
- Create: `packages/marketing/src/campaign/recipients.ts`, `src/campaign/recipients.test.ts`

**Interfaces:**
- Consumes: Task 1 columns; Task 3 `recordLedger`, `deleteLedger`, `countRecentSends`, `ledgerRef`, `EffectiveCap`; Task 7 `DeliveryOutcome`.
- Produces (each write that changes statuses updates `campaign_counters` with the deltas in the same transaction):
  - `MAX_SEND_ATTEMPTS = 5`; `SENDING_LEASE_MS = 2 * SEND_TIMEOUT_MS + LEASE_MARGIN_MS`.
  - `claimRecipients(sql: Sql, args: { campaignId: string; limit: number; now: Date; leaseMs: number }): Promise<{ token: string; profileIds: string[] }>`: `UPDATE ... SET status = 'leased', lease_token = $token, lease_until = now + leaseMs FROM (SELECT ... WHERE campaign_id = $1 AND status = 'pending' AND due_at <= now ORDER BY due_at LIMIT $n FOR UPDATE SKIP LOCKED)`.
  - `markLeasedFinal(sql, token: string, status: 'skipped' | 'failed', items: { profileId: string; reason: string }[]): Promise<number>` (only rows `leased` with the token; used for lookup skips and render failures, which never reach a provider).
  - `markSending(sql, args: { campaignId: string; projectId: string; channel: string; token: string; profileIds: string[]; now: Date; cap: EffectiveCap | null }): Promise<{ sending: string[]; capped: string[]; notRunning: boolean }>`: one transaction; `SELECT state FROM campaigns WHERE id = $1 FOR SHARE`; not `running` → no change and `notRunning: true`; with a cap, `countRecentSends` (excluding the campaign's own refs) and rows at or over `max` become `skipped` reason `capped`; the rest become `sending`, `attempt = attempt + 1`, `lease_until = now + SENDING_LEASE_MS`, and get a ledger row each.
  - `markOutcomes(sql, args: { campaignId: string; token: string; outcomes: DeliveryOutcome[]; now: Date; retryAt: Date }): Promise<{ applied: number }>`: only rows `sending` with the token; `sent` → `sent`, `sent_at`, `provider_ref`; `failed` → `failed` with reason, ledger row deleted; `uncertain` → `uncertain` with reason and `provider_ref`, ledger kept; `retry`, `rate_limited`, `channel_error` → `pending`, `due_at = retryAt`, lease cleared, ledger deleted, reason `rate_limited` / `channel_error` / null, except that a row whose `attempt >= MAX_SEND_ATTEMPTS` becomes `failed` reason `max_attempts`. Outcomes for rows no longer held are ignored (counted out of `applied`).
  - `releaseLeased(sql, token: string, dueAt?: Date): Promise<number>`: every row still `leased` with the token back to `pending` (lease cleared, attempt unchanged, `due_at` moved only when given).
  - `reapExpiredLeases(sql, now: Date): Promise<{ released: number; uncertain: number }>`: expired `leased` → `pending`; expired `sending` → `uncertain` reason `lease_expired` (ledger kept); never touches a row whose lease is still valid.

- [ ] **Step 1: Write the failing tests** (test Postgres): `two parallel claims of 500 over 800 pending rows return disjoint sets totalling 800`; `rows due in the future are not claimed`; `markSending on a paused campaign changes nothing and reports notRunning`; `markSending with a cap of 1 per day skips a person with a ledger row today as capped and writes ledger rows for the rest`; `markSending with an old token changes nothing`; `markOutcomes maps each outcome as listed and updates counters once per call`; `a retry at attempt 5 becomes failed max_attempts`; `a late markOutcomes after the reaper set uncertain changes nothing and does not double-count` (clock skew: lease expired, reaper ran, then the slow worker reports `sent`); `releaseLeased returns only leased rows of that token`; `reap turns an expired sending row uncertain and an expired leased row pending`; `a cancelled campaign's leased rows (plan 1 cancel marks them skipped) cannot be marked sending`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `recipients.ts` (bulk updates through `unnest($n::text[], $m::text[])`).
- [ ] **Step 4: Run** them (PASS).
- [ ] **Step 5: Commit** `feat(marketing): fenced recipient leases with uncertain rows on crash`.

---

### Task 13: Dispatch cycle

**Files:**
- Create: `packages/marketing/src/campaign/dispatch.ts`, `src/campaign/dispatch.test.ts`
- Modify: `src/audience/fake-source.ts` and its test (plan 1 file: `lookup` implemented), `src/engine/ticker.ts` (export `loadConfig` as `loadChannelConfig(schema: z.ZodType<unknown>, encrypted: string, encryptionKey: string)`)

**Interfaces:**
- Consumes: Tasks 2 to 12; plan 1 `withCampaignLane`, `createCampaignService(...).completeIfDone`, `.failCampaign`; `SourceResolver`; `filterLiveTokens`, `recordDeadTokens`; `redactSecrets`; `renderTemplate`.
- Produces in `fake-source.ts`: `FakeMember` gains `devices?: { token: string; platform: string }[]`, `traits?: Record<string, string | number | boolean>`, `consent?: { whatsapp?: boolean; sms_promotional?: boolean }`, `lookupStatus?: 'not_found' | 'suppressed' | { unreachable: string }`; `lookup(ids, channel)` returns one entry per id with the channel's address (`phone` for sms and whatsapp, `email`, `devices` for push, none for `none`) and honours `down()` and `pageDelayMs`.
- Produces in `dispatch.ts`:
  - `interface DispatchDeps { sql: Sql; redis: Redis; cfg: MarketingConfig; sources: SourceResolver; registry: ReturnType<typeof createTemplateRegistry>; campaigns: Pick<ReturnType<typeof createCampaignService>, 'completeIfDone' | 'failCampaign'>; bucket: ReturnType<typeof createRateBucket>; backoff: ReturnType<typeof createChannelBackoff>; renderUnsubscribeUrl: (projectId: string, profileId: string, channel: string) => string; now: () => Date; sleep: (ms: number) => Promise<void> }`.
  - `runDispatchCycle(deps: DispatchDeps): Promise<{ campaignId: string | null; claimed: number; sent: number; skipped: number; failed: number; uncertain: number; released: number }>` (`campaignId` null means nothing was due).
- Cycle (order fixed; not determined by the signature):
  1. Pick one campaign: `state = 'running' AND materialize_state = 'done' AND (dispatch_retry_at IS NULL OR dispatch_retry_at <= now)` with a pending due row, oldest `dispatch_retry_at` first, `FOR UPDATE SKIP LOCKED` on the campaign row only for the pick (released at once).
  2. Before claiming: channel backoff active → set `dispatch_retry_at` to its end, return; effective quiet hours (`effectiveQuietHours`) active → `dispatch_retry_at = nextAllowedTime(...)`, return (rows stay pending; not a skip); email: `remainingQuota` 0 → `dispatch_retry_at = nextQuotaDayStart`, `dispatch_error = 'quota_exhausted'`, return; no channel config → `dispatch_error = 'channel_not_configured'`, retry in 60 s.
  3. `claimRecipients` with `limit = min(claimSize(rate), remainingQuota)` and `leaseMs = cfg.leaseSeconds * 1000`.
  4. Everything below runs in `try/finally`; the `finally` calls `releaseLeased(token)` so a row leased but never marked `sending` always returns to the pool.
  5. Lookup through `withCampaignLane(source)` with lookup channel `push | sms | whatsapp | email | none` (webhook). `SourceUnavailableError` or `SourceBusyError` → `dispatch_retry_at = now + 30 s`, `dispatch_error = 'source_unavailable'`, return; `SourceAuthError` → the same with `source_auth_failed` and `audience_sources.status`; `SourceProtocolError` → `dispatch_failures + 1`, retry in 30 s, at 5 `failCampaign(id, 'source_error')`. Any successful lookup resets `dispatch_failures` and `dispatch_error`.
  6. Per entry, first match is the skip reason (`markLeasedFinal(..., 'skipped', ...)`): `not_found`; `suppressed`; `unreachable:<reason>` (reason passing `/^[a-z0-9_.-]{1,64}$/`, else `unreachable:other`); a row in the plugin's `opt_outs` for the channel → `opted_out`; `requireConsent` on and `consent.whatsapp !== true` (whatsapp) or, for sms with a `promotional` template, `consent.sms_promotional !== true` → `consent`; push with no live token after `filterLiveTokens` → `unreachable:no_live_token`; a render failure is `markLeasedFinal(..., 'failed', ...)` with reason `missing_variable` or `render_failed`, before any call.
  7. Render: push, email and webhook from `campaigns.template` with `renderTemplate` (`profile = traits`, `event = {}`); sms and whatsapp from the pinned `template_version` with `renderProviderVariables`.
  8. `acquireTokens` for the renderable count with budget `leaseMs - SENDING_LEASE_MS`; items without a token stay leased and are released in step 4.
  9. `markSending` (cap from `effectiveCap(campaign.frequency_cap, project caps)`); `notRunning` → return (cancel and pause take effect here, within one cycle).
  10. `getBatchAdapter(channel).sendBatch(items, config, { concurrency: settings.concurrency })`; per-project-channel in-process semaphore of `settings.concurrency` shared by the lane's loops.
  11. `markOutcomes` with `retryAt = now + max(retryAfterMs)`; any `rate_limited` → `backoff.set(project, channel, retryAfterMs)`; any `channel_error` → `dispatch_error = 'channel_auth_failed'`, `dispatch_retry_at = now + 60 s`; `invalidTokens` → `recordDeadTokens`.
  12. `completeIfDone(campaignId)`.
- Lock order (binding, from plan 1's cancel and fail): the campaign row first, then its recipient rows. Any dispatch path that locks both (`markSending`, outcome marks, the reaper) takes them in that order, or it can deadlock against a cancel.
- `campaign_counters.queued` means "materialised as pending" and is set once by the materialiser; dispatch never subtracts from it. Progress is read from `sent`, `failed`, `skipped` and `uncertain` (document this in the GUIDE's campaign section).
  Contact values of the batch are collected first and passed to `redactSecrets` with the channel secrets for every caught error; nothing from an entry is logged.

- [ ] **Step 1: Write the failing tests** (fake source, fake adapters registered per test, test Postgres and Redis, injected clock and sleep): `1,200 push recipients finish completed with counters sent 1,200 and each profile sent once`; `not_found, suppressed, unreachable:no_valid_phone and an opted_out id are skipped with those reasons`; `requireConsent on whatsapp skips consent false and consent missing, and sends consent true`; `sms service-category templates ignore sms_promotional`; `a missing trait fails that recipient with missing_variable and sends the others`; `quiet hours active leaves every row pending with no skip and sets dispatch_retry_at to the window end`; `an email campaign with quota 100 sends 100 today and resumes the rest at local midnight` (fake clock); `a frequency cap of 1 per day skips a person a journey already messaged today as capped`; `a 429 from the adapter backs off the channel for Retry-After and leaves rows pending, then completes`; `channel_error leaves every row pending with dispatch_error channel_auth_failed and nothing failed` (Review Focus 1); `pause between lookup and markSending returns the batch to pending and sends nothing`; `cancel between lookup and markSending sends nothing`; `the source down returns the batch to pending with dispatch_error source_unavailable and no failed mark`; `five protocol errors fail the campaign with source_error`; `a dispatch error thrown by the adapter leaves the batch sending, and the reaper later marks it uncertain`; `the rate bucket at 10 per second paces 30 sms recipients over about 3 s through the injected sleep`; `a push invalid token is recorded as a dead token hash`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** `dispatch.ts`, the fake lookup and the `loadChannelConfig` export.
- [ ] **Step 4: Run** them and the package suite (PASS).
- [ ] **Step 5: Commit** `feat(marketing): campaign dispatch with lookups, skips, pacing and fenced sends`.

---

### Task 14: Campaign lane in the worker and test-send delivery

**Files:**
- Create: `packages/marketing/src/campaign/dispatch-lane.ts`, `src/campaign/dispatch-lane.test.ts`, `src/campaign/test-sends.ts`, `src/campaign/test-sends.test.ts`
- Modify: `src/config.ts`, `src/config.test.ts`, `src/worker.ts`, `src/worker.test.ts`

**Interfaces:**
- Consumes: Task 13 `runDispatchCycle`, `DispatchDeps`; Task 12 `reapExpiredLeases`; plan 1 `campaign_test_sends`.
- Produces in `config.ts`: `MarketingConfig.campaignConcurrency` from `MARKETING_CAMPAIGN_CONCURRENCY` (integer 1..32, default 2); the pool check becomes `MARKETING_DB_POOL >= MARKETING_SEND_CONCURRENCY + MARKETING_CAMPAIGN_CONCURRENCY + 3` (defaults 10 + 2 + 3 = 15 still boot).
- Produces in `dispatch-lane.ts`: `startDispatchLane(deps: DispatchDeps & { concurrency: number; idleMs: number; secrets: string[] }): Stoppable`: `concurrency` independent loops; each runs `runDispatchCycle` again at once when it claimed rows and sleeps `idleMs` (`cfg.tickMs`) when nothing was due; errors are logged redacted and the loop continues; `stop()` lets in-flight cycles finish their final marks. A separate `every(cfg.tickMs, 'reap campaign leases', ...)` runs `reapExpiredLeases`. Journeys keep their own `every(cfg.tickMs, 'tick', ...)`.
- Produces in `test-sends.ts`: `runTestSendTick(deps: DispatchDeps): Promise<{ sent: number; failed: number; skipped: number }>`: claims up to 10 `pending` test sends (`FOR UPDATE SKIP LOCKED`), sets them `sending` with `lease_until = now + SENDING_LEASE_MS` before anything else (at most once), looks up the one profile, renders the campaign's template (sms and whatsapp: `template_version` when pinned, else the current version, `skipped` `template_disabled` when disabled), sends through the batch adapter with concurrency 1 and the rate bucket; ignores quiet hours, frequency cap and quota and writes no ledger row; marks `sent` with `provider_ref`, `failed` with the code, or `skipped` with the lookup reason; a `sending` row past its lease is marked `failed` reason `uncertain`. Runs as its own `every(cfg.tickMs, 'test sends', ...)`.

- [ ] **Step 1: Write the failing tests**: config: `MARKETING_CAMPAIGN_CONCURRENCY defaults to 2, rejects 0 and 33`; `a pool of 14 with defaults is rejected`. Lane: `two loops drain 2,000 recipients with no profile sent twice`; `stop waits for an in-flight cycle's marks`; `a cycle that throws does not stop the loop`. Test sends: `a pending test send to a fake push profile is delivered once and marked sent`; `a test send during quiet hours is still sent`; `a test send writes no ledger row`; `a disabled template skips with template_disabled`; `an expired sending test send becomes failed uncertain`; worker: `startWorker starts the lane, the reaper and the test-send job and stops them`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** and wire in `worker.ts` (each job in its own `every` or loop).
- [ ] **Step 4: Run** the package suite (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): campaign send lane and test-send delivery in the worker` (body: new optional env `MARKETING_CAMPAIGN_CONCURRENCY`, default 2; the `MARKETING_DB_POOL` check now includes it).

---

### Task 15: Operator routes: retry uncertain, recipients, estimate and the quota gate

**Files:**
- Create: `packages/marketing/src/campaign/operator.ts`, `src/campaign/operator.test.ts`
- Modify (plan 1 files): `src/campaign/state.ts` and `state.test.ts` (action `reopen`: `completed` → `running`), `src/campaign/service.ts` and `service.test.ts` (quota gate, `confirm.spreadOverDays`), `src/api/routes-campaigns.ts` and `routes-campaigns.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6, 12; plan 1 service, `nextState`, `fromStates`, `AudienceCount`.
- Produces in `operator.ts`:
  - `retryUncertain(sql: Sql, ctx: { projectId: string }, campaignId: string): Promise<{ retried: number }>`: allowed in `running`, `paused` and `completed` (`completed` is reopened to `running` through `reopen`; the one-active index violation is `409 another_campaign_active`); in one transaction every `uncertain` row becomes `pending` with reason `operator_retry` and `due_at = now`, its ledger row is deleted, `counters.uncertain -= n`. Other states `409 invalid_transition`.
  - `listRecipients(sql, ctx, campaignId, query: { status?: RecipientStatus; cursor?: string; limit: number }): Promise<{ recipients: { profileId: string; status: string; reason: string | null; attempt: number; providerRef: string | null; sentAt: string | null; updatedAt: string }[]; nextCursor: string | null }>` (keyset on `profile_id`, limit 1..500).
  - `skipReasons(sql, ctx, campaignId): Promise<{ reasons: { status: 'skipped' | 'failed' | 'uncertain'; reason: string; count: number }[] }>`.
  - `estimateCampaign(deps, ctx, campaignId): Promise<{ count: number; channel: string; ratePerSecond: number | null; estimatedSeconds: number | null; cost: { amount: number; currency: string } | null; quota: { dailyQuota: number; usedToday: number; remainingToday: number; daysNeeded: number } | null; issues: string[] }>` (count from the campaign's current count preview, `409 count_preview_required` without one; `estimatedSeconds = ceil(count / ratePerSecond)`; `cost = count * pricePerMessage.amount`; `quota` for email only; `issues` from `checkChannelSettings` and `channelReady`).
- Service change: for `email`, after the confirmation gate, when the preview count exceeds `remainingQuota`, `start` and `schedule` answer `409 quota_spread_required` with `{ count, remainingToday, daysNeeded }` unless `confirm.spreadOverDays === true`. Dispatch always waits for the next quota day (Task 13), so spreading needs no stored flag.
- Routes (`auth: 'dashboard'`, under `/marketing/`): `POST campaigns/:id/retry-uncertain` → `{ retried, campaign: CampaignRow }`; `GET campaigns/:id/recipients?status=&cursor=&limit=`; `GET campaigns/:id/skip-reasons`; `POST campaigns/:id/estimate`; `GET campaigns/:id/test-sends` → `{ testSends: { id; profileId; status; reason; createdAt; sentAt }[] }` (latest 50). `CampaignRow` also exposes `templateVersion`, `dispatchError`, `dispatchRetryAt`.

- [ ] **Step 1: Write the failing tests**: `retry-uncertain on a completed campaign with 3 uncertain rows reopens it, sends those 3 once and completes again`; `retry-uncertain while another campaign is active is another_campaign_active`; `retry-uncertain on a draft is invalid_transition`; state: `completed accepts reopen and nothing else; cancelled, failed and missed accept nothing`; `recipients pages by profile id with a status filter`; `skip-reasons groups counts by status and reason`; `estimate: 20,000 sms at 0.25 INR and 100 per second is 5,000 INR and 200 s`; `estimate for email with quota 500 and 120 used today needs 41 days for 20,000`; `an email start over the remaining quota without spreadOverDays is quota_spread_required; with it, it starts`; `estimate without a preview is count_preview_required`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the package suite (PASS) and `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): retry uncertain sends, recipient lists and cost and quota estimates`.

---

### Task 16: Role rules for the new routes

**Files:**
- Modify: `apps/start/src/components/marketing/proxy.ts` (`ALLOWED_ROUTES`), `apps/start/src/components/marketing/proxy.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 9, 15 paths (relative to `/marketing-api/`).
- Produces in `ALLOWED_ROUTES` (spec 6.5: members see the registry but cannot change it; channel settings follow the Phase 1 rule that channel config is admin):
  - member: `GET templates`, `GET templates/[^/]+`, `GET templates/[^/]+/versions/[0-9]+`, `POST templates/[^/]+/preview`, `GET campaigns/[^/]+/recipients`, `GET campaigns/[^/]+/skip-reasons`, `POST campaigns/[^/]+/estimate`, `GET campaigns/[^/]+/test-sends`.
  - admin: `POST templates`, `PUT templates/[^/]+`, `POST templates/[^/]+/(enable|disable)`, `GET|PUT channels/(push|whatsapp|sms|email|webhook)/settings`, `GET|PUT channels/(sms|whatsapp)` (credentials), `POST campaigns/[^/]+/retry-uncertain`.

- [ ] **Step 1: Write the failing tests**: `a member may list, read and preview templates`; `a member gets 403 on creating, editing, enabling or disabling a template`; `a member gets 403 on channel settings and sms credentials`; `an admin may retry uncertain sends`; `a no-access user gets 404 on every new route`; `templates/x/delete is 404`.
- [ ] **Step 2: Run** `bunx vitest run` in `apps/start`; expect FAIL.
- [ ] **Step 3: Implement** the entries.
- [ ] **Step 4: Run** `bunx vitest run` (PASS), root `bun run typecheck`, `check-fork.ts`.
- [ ] **Step 5: Commit** `feat(dashboard): role rules for templates, channel settings and send operations`.

---

### Task 17: Crash, duplicate and outage tests

**Files:**
- Create: `packages/marketing/src/campaign/dispatch.crash.test.ts`, `src/campaign/dispatch.outage.test.ts`

**Interfaces:**
- Consumes: Tasks 12 to 15, the fakes of Tasks 7, 8, 11 and plan 1's fake source. A test adapter wraps a fake and can throw at a chosen point: after `markSending` before the call, after the provider accepted before `markOutcomes`, or in the middle of `markOutcomes` (simulated crash: the cycle's promise is abandoned and its lease left to expire).

- [ ] **Step 1: Write the tests** (each asserts the fakes' `delivered` count is at most 1 per profile and every recipient ends in exactly one final status): `crash after markSending and before the call: rows become uncertain after the lease, nothing is resent, retry-uncertain then sends each once`; `crash after the provider accepted: rows uncertain, the provider counted 1, never 2`; `crash while leased (before markSending): rows return to pending and are sent once`; `three replicas (three lanes, two loops each) over 20,000 recipients with random crashes in 1% of cycles: no profile delivered twice, sent + uncertain + skipped + failed = 20,000`; `cancel during a running 5,000-recipient send: no row is sent after the cancel's commit` (record the commit time, compare each `sent_at` and each fake delivery time); `pause and resume: nothing is delivered while paused and the rest is delivered once after resume`; `the audience API failing for 60 s (fake clock) mid-campaign: dispatch_error source_unavailable, no failed mark, no duplicate, completes after recovery` (spec 6.4); `the API at 2 s per lookup: no lease expires, no timeout, completes`; `a 429 storm on whatsapp delays only whatsapp: a push campaign of another project keeps sending`.
- [ ] **Step 2: Run** them; expect PASS if Tasks 12 to 15 are right (a failure is a bug in source, fixed there, not in the test).
- [ ] **Step 3: Commit** `test(marketing): no duplicate sends under crashes, cancels, replicas and outages`.

---

### Task 18: Load scripts and measured targets

**Files:**
- Create: `packages/marketing/scripts/load-campaign.ts`
- Modify: `packages/marketing/docs/GUIDE.md` (section "Measured performance"), and, only for a target not met, the spec's section 6.4 table

**Interfaces:**
- Consumes: Tasks 7, 13, 14; plan 1 fake source and `load-materialize.ts` conventions (refuses a database not ending in `_test` unless `MARKETING_LOAD_ALLOW=1`; project ids prefixed `marketing-load-`; cleanup at the end).
- Produces: `bun scripts/load-campaign.ts --mode noop|isolation|slow-api|fcm [--recipients 20000] [--loops 2] [--delay-ms 2000] [--fcm-latency-ms 150] [--fcm-tokens-per-second 600]`, printing one JSON line per run with `mode, recipients, elapsedMs, sendsPerSecond, duplicates, missing, uncertain` plus, for `isolation`, `journeyIdleMedianMs` and `journeyDuringMedianMs`. Exit 1 when `duplicates` or `missing` is non-zero, or a target is missed: `noop` below 1,000 sends/s (one replica, no-op adapter that returns `sent` at once, instant fake source); `isolation` with the during-campaign median above 2x the idle median (200 due journey steps measured from `due_at` to `sent_at`, idle first, then during a 20,000-recipient campaign); `slow-api` with any timeout, duplicate or unfinished campaign (lookup delayed 2 s); `fcm` not finished within 600 s (20,000 recipients, one token each, the fake FCM at the given latency and rate).

- [ ] **Step 1: Write** the script.
- [ ] **Step 2: Run** each mode against the test database and paste every JSON line into the task report.
- [ ] **Step 3: Write** the measured values (machine, loops, numbers, date) into GUIDE "Measured performance". Where a target was not met, put the measured value and the reason into the spec's 6.4 table instead of the target (spec rule); never write a target as achieved without its line from Step 2.
- [ ] **Step 4: Commit** `test(marketing): campaign load script with measured throughput and lane isolation`.

---

### Task 19: Personal-data scan, docs and phase checks

**Files:**
- Modify: `packages/marketing/src/engine/pii.test.ts`, `packages/marketing/README.md`, `packages/marketing/docs/GUIDE.md`, `packages/marketing/AGENTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a PII case that runs one campaign per channel (push through the fake FCM, sms and whatsapp through the fake MSG91 scripted to answer one 400 whose body quotes the canary phone and auth key, email through the fake SMTP answering one 550 that quotes the canary address, webhook) for fake members carrying the Phase 1 canaries (`pii-canary@example.test`, `919999900001`, `Canary Student`, a canary device token), plus a test send, a retry of uncertain rows and a template preview, then the existing scan of every `marketing` table (`row_to_json`), Redis `marketing:*` (including `marketing:rate:*` and `marketing:channel-backoff:*`) and captured console. Docs (GUIDE, with the routes, settings keys and env checked against code with `grep`): MSG91 setup (own auth key and integrated number in Settings > Channels; DLT flow template id, sender id and variable names; Meta template name, namespace, language and `header_n`/`body_n` mapping; category; first real send is a one-recipient test to the owner's number); email provider recommendation (Amazon SES Mumbai, Brevo, Mailgun or SendGrid with SPF, DKIM and DMARC; free Gmail SMTP's about 500 a day cannot carry 20,000); quiet hours (channel setting, per-campaign override, rows stay pending, not a skip); quotas and spreading; rate and concurrency; consent; frequency cap and its `scope`; skip and failure reasons; `uncertain` rows, why they exist and how to retry them; cost estimate; upgrade notes (migrations 0013 and 0014, `MARKETING_CAMPAIGN_CONCURRENCY`, the DB pool check, the journey cap now reading the shared ledger).

- [ ] **Step 1: Write** the PII case; run it; expect PASS (a failure is a leak to fix in source).
- [ ] **Step 2: Write** the docs.
- [ ] **Step 3: Final verification**: package suite (`MARKETING_ALLOW_RESET=1`), `bunx vitest run` in `apps/start`, root `bun run typecheck`, `check-fork.ts`, `check-rename.ts`, `npx ultracite fix` on every file this plan touched, and `grep -rn "msg91.com" packages/marketing/src --include=*.test.ts` returning nothing (no test points at the real host). Record each output in the report.
- [ ] **Step 4: Commit** `docs(marketing): send engine, MSG91 and channel settings guide`.

---

## Interfaces plan 3 consumes

All paths are under `/marketing-api/` in the dashboard (worker `/marketing/`); roles per Task 16 and plan 1 Task 13.

- Channel settings: `GET|PUT channels/:channel/settings`, `:channel` in `push|whatsapp|sms|email|webhook`; `PUT` body `{ settings, expectedVersion }`; response `{ channel, settings, version, configured, issues }`. Settings keys: `concurrency`, `ratePerSecond`, `quietHours { enabled, start, end, timezone }`, `requireConsent`, `pricePerMessage { amount, currency } | null`, `dailyQuota`, `quotaTimezone`. Issue codes: `rate_required`, `quota_required`; a refused `PUT` answers `invalid_settings` with `consent_not_supported` or `quota_not_supported`.
- Channel credentials (existing shape `{ channel, configured, config }`, `PUT { config }`): now also `channels/sms` `{ authKey (masked), baseUrl?, defaultCountryCode? }` and `channels/whatsapp` `{ authKey (masked), integratedNumber, baseUrl?, defaultCountryCode? }`.
- Templates: `GET templates?channel=`, `POST templates`, `GET|PUT templates/:id`, `GET templates/:id/versions/:version`, `POST templates/:id/enable|disable`, `POST templates/:id/preview`. Input `{ channel, displayName, category, providerRef, approvedText, variables: [{ slot, value }] }`; sms `providerRef { flowId, senderId? }`, whatsapp `{ templateName, namespace, language, integratedNumber? }`. Row adds `id, version, enabled, currentVersion, createdBy, createdAt, updatedAt`. Errors: `mapping_mismatch`, `channel_immutable`, `version_conflict`.
- Campaign start errors added: `channel_not_configured`, `rate_required`, `quota_required`, `template_not_found`, `template_disabled`, `template_mapping_missing`, `template_channel_mismatch`, `quota_spread_required { count, remainingToday, daysNeeded }` (answered by resending `confirm` with `spreadOverDays: true`). Campaign `template` for sms and whatsapp is `{ templateId }`.
- Campaign operations: `POST campaigns/:id/retry-uncertain` → `{ retried, campaign }` (409 `invalid_transition`, `another_campaign_active`); `GET campaigns/:id/recipients?status=&cursor=&limit=`; `GET campaigns/:id/skip-reasons`; `POST campaigns/:id/estimate`; `GET campaigns/:id/test-sends` (status `pending|sending|sent|failed|skipped`; reasons: campaign state, `template_not_found`, `template_disabled`, `channel_not_configured`, `source_not_http`, `source_unavailable`, `source_auth_failed`, `rate_limited`, `uncertain`, a skip or render reason, or the provider's reason). `CampaignRow` gains `templateVersion`, `dispatchError` (`source_unavailable`, `source_auth_failed`, `source_error`, `channel_auth_failed`, `channel_unreachable`, `channel_not_configured`, `quota_exhausted`, `quiet_hours`, `rate_limited`, `dispatch_error`) and `dispatchRetryAt` (set only while `dispatchError` is); `stateReason` may be `source_error`, `source_not_http`, `template_not_found`, `template_unavailable`, `invalid_frequency_cap`, `materialize_failed`, `materialize_restart_after_sending`, or `late` on a missed campaign.
- Recipient reasons to label: `not_found`, `suppressed`, `unreachable:<reason>`, `opted_out`, `consent`, `capped`, `cancelled`, `already_received`, `missing_variable`, `render_failed`, `max_attempts`, `lease_expired`, `operator_retry`, `rate_limited`, `channel_error`, `failed` (campaign failed), `unreachable:no_live_token`, `no_phone`, `no email`, `invalid email`, `invalid unsubscribe url`, `no device tokens`, `blocked url`, `timeout`, `network`, `network error`, `exception`, `deadline`, `breaker`, `msg91 failed`, `msg91 conflicting`, `msg91 unlisted`, and codes `msg91 <code>`, `fcm <code>`, `smtp <code>`, `http <status>`.
- Project settings: `caps` gains `scope: 'channel' | 'all'`.

## Self-review notes

- **Spec coverage.** 6.2 test send (Task 14), quota and spreading (Tasks 6, 13, 15), cancel and pause within one cycle and resume (Tasks 12, 13, 17); 6.3 batch claim with lease, lookup ≤500, render, fenced `sending`/`sent` with idempotency key, at most once, `uncertain` and operator retry, leased rows back to the pool, separate lane and budget, journey priority on the API cap (plan 1 lane reused), concurrency and rate per channel, 429 per channel, channel batching and keep-alive, pooled SMTP, scale out by leases, counters in batches (Tasks 7 to 15); 6.4 targets (Tasks 17, 18; materialise targets are plan 1's); 6.5 registry, own credentials, consent, quiet hours, rate and cost, per-recipient outcomes, accept-only delivery status (Tasks 2, 4, 5, 9, 10, 15); 8 Phase 2 items for skips, fake MSG91, no real sends, crash and replica tests (Tasks 13, 17, 19); 9 calls 6, 10, 11, 19, 21, 24, 25 (Tasks 2, 3, 6, 11, 12).
- **Rulings made by this plan (not in the spec):** listed in the hand-off report and repeated in GUIDE by Task 19.
