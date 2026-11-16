# Marketing Phase 3 (journeys from the workbook, versioned templates, email editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner's 11 workbook journeys arrive as reviewable drafts with one message per state, operators create, edit, test and start journeys in the dashboard, push and email templates are named and versioned and pinned at start, and email gets a block editor.

**Architecture:** Journeys stay `marketing.rules` rows (linear: trigger, steps with delays, goal). A step keeps one channel and gains optional per-state message variants keyed by the student's `state` trait, read from the `/members/lookup` traits the ticker already fetches (nothing is copied). Drafts are a new rule status the engine never loads; an importer (own minimal xlsx/CSV reader, no new dependency) turns the workbook into drafts by journey key. Template references in steps are resolved to an immutable copy of one template version when the journey starts, so enrollments (which snapshot the definition) never see later edits.

**Tech Stack:** Bun, TypeScript, zod, Postgres (plain-SQL migrations in `packages/marketing/migrations/`), `node:zlib` for xlsx, bun test; dashboard: TanStack Start, React 19, @tanstack/react-query, Tailwind v4, vitest (pure TS, no jsdom).

**Spec:** `docs/superpowers/specs/2026-11-15-marketing-phases-3-5-design.md` (section "Phase 3", binding), building on `docs/superpowers/specs/2026-10-28-marketing-platform-design.md` (sections 4 to 7) and `docs/superpowers/specs/2026-10-22-journey-nudge-plugin-design.md`. Conventions and the engine's interfaces: `docs/superpowers/plans/2026-11-03-marketing-phase2-engine.md`, `docs/superpowers/plans/2026-11-14-marketing-phase2-dashboard.md`.

## Global Constraints

- Student data is never copied: no phone, email, token or trait value in any marketing table, Redis key or log; the dashboard shows ids and masked displayName only.
- At-most-once sending.
- No journey frequency caps (quiet hours still apply).
- Opt-out is out of scope.
- A/B tests and branching journeys are out of scope.
- Imports create DRAFT journeys only and never touch a live journey. Re-import updates drafts by journey key.
- Commit trailer exactly `Co-Authored-By: Claude <noreply@anthropic.com>`.
- No breaking-change markers: no `!`, `BREAKING CHANGE`, `[major]`, `[minor]`, `[release now]`.
- Never push.
- One writer agent at a time.
- Dashboard pure helpers with vitest (no jsdom). Backend tests `bun test --isolate` with the test env.
- Test env (unchanged from phase 2): from `packages/marketing`, `MARKETING_ALLOW_RESET=1`, `DATABASE_URL` on a database whose name ends in `_test`, `REDIS_URL` on db index 6, containers `docker compose -p nudge up -d op-db op-kv op-rp`; run one test command at a time (low memory). Dashboard: `bunx vitest run src/components/marketing` in `apps/start`. Before each commit: `bun run typecheck` at the repo root and `npx ultracite fix <touched files>`.
- Variant keys (state values such as the ones the `state` dimension returns) are operator configuration and may live in rule definitions. Nothing per student records the student's state or which variant was chosen; skip reasons are codes only (`no_state_trait`, `no_variant_for_state`, `template_not_pinned`), never values.
- No new npm dependency in either package (`apps/start/package.json` and `packages/marketing/package.json` stay as they are).
- The dashboard never imports from `packages/marketing/src`; it keeps its own zod copy. The block in `apps/start/src/components/marketing/contract.ts` from `const MAX_SUBJECT_LENGTH` to `export type RuleDefinition = z.infer<typeof zRuleDefinition>;` must stay text-identical (whitespace-normalised) to the same block in `packages/marketing/src/rules/rule.schema.ts` (`contract.test.ts`); any schema change is made identically in both.
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

  Every file this plan modifies is a plugin file (under `packages/marketing/` or `apps/start/src/components/marketing/`), created by earlier phases.

## Facts this plan relies on (verified in code and in the workbook)

- **Workbook** `SIA_Exam_Ready_GenZ_Situational_InApp_Journeys_TS_AP.xlsx` (24 KB): three sheets, `Telangana`, `Andhra Pradesh`, `Journey Rules`. Strings are inline (`t="inlineStr"`, no `sharedStrings.xml`), no merged cells. The two state sheets have the header row `Event Name | Platform | Timing | Message (Content) | Template Idea (Image/Visual) | Instructions` (columns A to F) and 53 data rows each, row-for-row the same `Event Name` and `Timing`. 11 journeys in order: Registration Started (5 rows), Invalid PIN / OTP (3), Incomplete Registration, Registration Completed, Home Page View, Book / Sample Viewed, Books Added to Cart, Cart Abandoned, Payment Failed, Mentor Viewed, Mentor Notify Click (5 each). `Platform` is always `In-App Notification`. `Timing` values: `D<n>` optionally followed by `Immediate`, `in session`, `on exit`, `after exit`, `confirmation`, or `on next failed login` (only Invalid PIN / OTP D1 and D3). No duplicate day within a journey. Messages are at most 159 characters; `Instructions` (CTA, conditions, KPI, segment) up to 429. `Journey Rules` is two columns `Area | Operational Rule / Recommendation` (18 rules) and lists success events `registration_completed; course_selection_completed; sample_read_continued; cart_reviewed; purchase_success; payment_issue_resolved; mentor_interest_confirmed`. The workbook has no production event names, no per-journey goal, no default variant and no reentry setting.
- **Journeys today:** `zRuleDefinition` (`src/rules/rule.schema.ts`) has steps `{ delaySeconds, channel: 'email'|'webhook'|'push', template: { subject?, body } }`; `marketing.rules.status` is `CHECK (status IN ('active','paused'))` (`migrations/0001_init.sql`); the engine and the Kafka interest set only load `status = 'active'`. `ENROLL_SQL` copies the whole definition into `enrollments.rule_snapshot` per enrollment. The ticker (`src/engine/ticker.ts` `deliver`, ~line 1115) renders `stepDef.template` with `render()` and `vars.profile = context.attributes`, which is `entry.traits` from the batched `/members/lookup` (`gatherLookupBatch`, at most 500 ids per call) or `marketing.contacts.attributes` for a project without an HTTP source. It passes the project cap to `step.reserve` (`effectiveCap(null, project caps)`), so journeys are capped today.
- **Traits:** the contract (`packages/marketing/docs/AUDIENCE_CONTRACT.md`, `src/audience/contract.ts` `zLookupEntry.traits`) allows any flat scalar trait, but the sia-backend plan returns only `traits{firstName,lastName}` and the reference mapping (`conformance/seed/reference-mapping.json`) maps only those. `state` is a filter dimension (`/audience/dimensions/state/values`), not a trait. **sia-backend must add `traits.state` to every `ok` lookup entry, for every channel including `push`, holding exactly the value the `state` dimension returns** (do not edit sia-backend; Task 12 records the requirement in the contract doc).
- **Templates today:** `marketing.message_templates` + `message_template_versions` (immutable rows, `current_version`), channels `sms`, `whatsapp` only (`src/templates/registry.ts`). Campaigns pin `template_version` at start (`campaign/service.ts`), dispatch reads `registry.getVersion` (`campaign/dispatch.ts` ~line 280).
- **`zStep.shape` users** that break if `template` changes shape: `src/campaign/definition.ts:110,111,124`, `src/campaign/dispatch.ts:501`, `src/api/routes-dashboard.ts:112-113`, dashboard `contract.ts:68`.
- Not re-read for this plan: the 2026-10-22 journey spec and the reentry/pause parts of the 2026-10-28 spec beyond sections 4 to 7; where they disagree with this plan, the 2026-11-15 spec wins.
- **Roles** are enforced by the dashboard proxy route table (`apps/start/src/components/marketing/proxy.ts`); rules `POST`/`PATCH`/`DELETE` are `admin`, campaign `test-send` is `admin`.
- Email adapter (`src/channels/email.ts` `buildMail`) sends `html` only; fake SMTP is `src/channels/fakes/smtp-server.ts`.

## Review Focus

1. **Workbook rows that do not map** (conditional timing, unknown sheet, missing column, empty message, unknown platform): the import still creates the drafts it can and lists every unmapped row with sheet, row number and a code; nothing is half-written. Test in Task 5 and Task 6.
2. **A student whose state has no variant, or no state trait at all** (today every student, until sia-backend adds `traits.state`): the step is skipped with `no_variant_for_state` or `no_state_trait`, visible per journey, and the default variant is used when one exists; the Start confirmation warns when no step has a default. Test in Task 2 and Task 9.
3. **Re-import over a draft someone edited in the dashboard:** the edited draft is left alone and reported `skipped_edited` unless the operator asks to overwrite, and then only steps are replaced (trigger, goal, name, reentry kept). Test in Task 6.
4. **A live journey edited or re-imported:** re-import never changes an active or paused journey (`skipped_live`); an admin edit of an active journey re-pins templates and running enrollments keep their old snapshot. Test in Task 4 and Task 6.
5. **Per-state variant cost at 50,000 students:** choosing a variant adds no audience-API call and no query per student, and the definition copied into every enrollment is bounded in size. Test in Task 1 (size bound) and Task 2 (call count).

---

### Task 1: Journey schema: per-state variants, template references, drafts

**Files:**
- Modify: `packages/marketing/src/rules/rule.schema.ts`, `apps/start/src/components/marketing/contract.ts` (identical block), `apps/start/src/components/marketing/starter-rules.fixture.json` only if the drift test needs it, `packages/marketing/src/campaign/definition.ts:110-124`, `packages/marketing/src/campaign/dispatch.ts:501`, `packages/marketing/src/api/routes-dashboard.ts` (`zPreview`, `zStatus`, `zCreateRule`, `zBoundedRule`, `RULE_COLUMNS`, `toRule`)
- Modify also: `packages/marketing/src/engine/engine.ts` (snapshot without step notes)
- Create: `packages/marketing/migrations/0016_journey_drafts.sql`
- Test: `packages/marketing/src/rules/rule.schema.test.ts`, `packages/marketing/src/api/routes.test.ts`, `packages/marketing/src/db/migrate.test.ts`, `apps/start/src/components/marketing/contract.test.ts`

**Interfaces:**
- Produces (in both schema copies):
  - `zStepTemplate = z.strictObject({ subject?: string ≤ MAX_SUBJECT_LENGTH, body?: string ≤ MAX_BODY_LENGTH, text?: string ≤ MAX_BODY_LENGTH, templateId?: z.uuid(), version?: int ≥ 1 })` refined: `body !== undefined || templateId !== undefined` (message `'body or templateId is required'`). `text` is the plain-text alternative (email only, filled by pinning in Task 3/11).
  - `zStep = z.object({ delaySeconds, channel: 'email'|'webhook'|'push', template: zStepTemplate.optional(), variants: z.record(z.string().trim().min(1).max(MAX_VARIANT_KEY_LENGTH), zStepTemplate).optional(), note: z.string().max(MAX_NOTE_LENGTH).optional() })` refined: `template !== undefined || Object.keys(variants ?? {}).length > 0` (`'a step needs a default message or a state variant'`) and at most `MAX_VARIANTS` keys. Constants: `MAX_VARIANTS = 40`, `MAX_VARIANT_KEY_LENGTH = 64`, `MAX_NOTE_LENGTH = 2000`, `MAX_DEFINITION_BYTES = 64 * 1024` (the definition is copied into every enrollment: 64 KiB × 50,000 enrollments is at most 3.2 GB for one journey, while a workbook journey is about 3 KB, about 150 MB). `engine.ts` drops `note` from each step when it builds `rule_snapshot` (operator notes are not needed to send).
  - Types `StepTemplate`, `Step`, `RuleDefinition` as before.
  - `zPushTemplate`/journey campaign shapes in `campaign/definition.ts` keep their current fields: build them from a new exported `zInlineTemplate = z.strictObject({ subject?: …, body: … })` in `rule.schema.ts` instead of `zStep.shape.template`; `dispatch.ts:501` parses with `zInlineTemplate`. Campaign JSON is unchanged.
  - Dashboard API: `zStatus = z.enum(['draft','active','paused'])`; `zCreateRule.status` default `'draft'`; `zBoundedRule` also rejects a definition whose `JSON.stringify` exceeds `MAX_DEFINITION_BYTES` (`'definition is too large'`). A rule row gains `journeyKey: string | null`, `unconfirmed: ('trigger'|'goal')[]` (the stored steps hash is not returned).
  - Migration `0016_journey_drafts.sql`: replace the status check with `CHECK (status IN ('draft','active','paused'))` (`DROP CONSTRAINT IF EXISTS rules_status_check`, then `ADD CONSTRAINT rules_status_check …`); `ADD COLUMN IF NOT EXISTS journey_key text NULL`, `unconfirmed text[] NOT NULL DEFAULT '{}'`, `imported_steps_hash text NULL` (sha256 of the steps JSON written by the last import); `CREATE UNIQUE INDEX IF NOT EXISTS rules_journey_key_uniq ON marketing.rules (project_id, journey_key) WHERE journey_key IS NOT NULL`.

- [ ] **Step 1: Write failing tests.** `rule.schema.test.ts`: `a step with only state variants parses`; `a step with neither template nor variants is rejected`; `a variant with templateId and no body parses`; `a template with neither body nor templateId is rejected`; `41 variants are rejected`; `an existing starter rule still parses unchanged`. `routes.test.ts`: `POST rules defaults to draft and the engine does not enroll a draft` (create a draft with trigger `t`, feed event `t` through the engine helper used by existing tests, expect 0 enrollments); `a definition over 64 KiB is rejected with 400`; `an enrollment's rule_snapshot has no step notes`. `migrate.test.ts`: `0016 allows status draft and keeps existing rows`. `contract.test.ts` keeps passing with the new block.
- [ ] **Step 2: Run** `bun test --isolate src/rules/rule.schema.test.ts src/api/routes.test.ts src/db/migrate.test.ts`; expect the new cases to FAIL.
- [ ] **Step 3: Implement** the schema in `rule.schema.ts`, copy the block into `contract.ts`, the migration, the route changes, and switch the `zStep.shape.template` users to `zInlineTemplate`. Add the step refinements with `.refine` on `zStep` itself: zod 4 keeps `.shape` on a refined object, so dashboard `CHANNELS = zStep.shape.channel.options` keeps working (assert it in `contract.test.ts`).
- [ ] **Step 4: Run** the three backend files, then `src/campaign/definition.test.ts src/campaign/dispatch.test.ts` one at a time, then `bunx vitest run src/components/marketing/contract.test.ts` in `apps/start`; expect PASS. `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): journeys can hold per-state messages and stay drafts until started`.

### Task 2: Engine picks the student's state variant; journeys are not capped

**Files:**
- Create: `packages/marketing/src/journeys/variants.ts`
- Modify: `packages/marketing/src/engine/ticker.ts` (`render`, `deliver`), `packages/marketing/src/engine/pii.test.ts`
- Test: `packages/marketing/src/journeys/variants.test.ts`, `packages/marketing/src/engine/ticker.test.ts`, `packages/marketing/src/engine/http-source-ticker.test.ts`

**Interfaces:**
- Consumes: `Step`, `StepTemplate` (Task 1).
- Produces: `STATE_TRAIT = 'state'`; `type MessageChoice = { ok: true; template: StepTemplate & { body: string } } | { ok: false; reason: 'no_state_trait' | 'no_variant_for_state' | 'template_not_pinned' }`; `chooseMessage(step: Step, traits: Record<string, unknown>): MessageChoice`. Rule: no variants → the default; the state value is `String(traits.state).trim()` when it is a string or number; exact key match wins; otherwise the default; otherwise `no_state_trait` when the value is absent or empty, else `no_variant_for_state`; a chosen template without `body` → `template_not_pinned`.
- `render(template: StepTemplate & { body: string }, channel, context, goal, meta)` is exported from `ticker.ts` (Task 7 reuses it).

- [ ] **Step 1: Write failing tests.** `variants.test.ts`: `no variants uses the default`; `state TS picks the TS variant`; `numeric state 36 matches key "36"`; `unknown state falls back to the default`; `unknown state and no default is no_variant_for_state`; `missing state and no default is no_state_trait`; `a variant with only templateId is template_not_pinned`. `ticker.test.ts`: `a step with no variant for the student's state is skipped with reason no_variant_for_state and nothing is sent`; `an unreachable student on a variants-only step keeps reason unreachable:no_active_device, not no_state_trait`; `a student over the project frequency cap still receives a journey step` (project caps `{max:1, periodSeconds:86400}`, one prior ledger row, expect `sent`); `quiet hours still defer a journey step` (expect rescheduled to `nextAllowedTime`); `a journey send still writes a send_ledger row` (campaign caps keep counting it). `http-source-ticker.test.ts`: `1,200 due steps across two states use the same number of lookup calls as without variants` (fake source counts calls; expect `ceil(1200 / 500)` in both runs and no extra SQL per claim — assert the fake's call count, not timings). `pii.test.ts`: add trait `state: 'ZZ-canary-state'` to the canary student with a journey whose variants are `TS`/`AP` and a default; after the run the canary value appears in no table, Redis key or log line.
- [ ] **Step 2: Run** `bun test --isolate src/journeys/variants.test.ts`, then `src/engine/ticker.test.ts`, then `src/engine/http-source-ticker.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `chooseMessage`; in `deliver`, after `skipReason` (so `not_found`, `unreachable` and `no_device` keep their own reasons; their entries carry no traits) and before quiet hours, call it with `context.attributes` and `step.finish('skipped', choice.reason)` on failure; render the chosen template; pass `cap: null` to `step.reserve` for journey steps (keep the ledger write).
- [ ] **Step 4: Run** the three files and `src/engine/pii.test.ts` one at a time; expect PASS. Existing tests that assert a journey step is skipped by the project cap (`grep -rn "cap" src/engine/*.test.ts`) are changed to the new rule, and `docs/GUIDE.md` lines that say caps cover journeys are corrected in this task.
- [ ] **Step 5: Commit** `feat(marketing): journey steps send the student's state wording and skip with a reason when none fits`. Body: journeys no longer obey the project frequency cap (spec decision); quiet hours still apply.

### Task 3: Push and email templates are named and versioned; pinning

**Files:**
- Create: `packages/marketing/migrations/0017_template_content.sql`, `packages/marketing/src/templates/pin.ts`
- Modify: `packages/marketing/src/templates/registry.ts`, `packages/marketing/src/api/routes-templates.ts` (list filter accepts the new channels)
- Test: `packages/marketing/src/templates/registry.test.ts`, `packages/marketing/src/templates/pin.test.ts`, `packages/marketing/src/api/routes-templates.test.ts`

**Interfaces:**
- Migration: `message_templates.channel` check becomes `('sms','whatsapp','push','email')`; `message_template_versions` gets `content jsonb NULL`, `provider_ref` and `approved_text` become nullable, plus `CHECK ((content IS NULL) = (provider_ref IS NOT NULL))`.
- `zTemplateInput` becomes a discriminated union on `channel`: the existing sms/whatsapp object unchanged, `{ channel: 'push', displayName, category, content: zInlineTemplate }`, and `{ channel: 'email', displayName, category, content: zEmailContent }`. Until Task 11, `zEmailContent` in `src/templates/email-blocks.ts` is a placeholder `z.strictObject({ subject: string ≤300, blocks: z.array(z.unknown()).min(1) })`; Task 11 replaces it. `TemplateVersion` gains `content: unknown | null`; `TemplateChannel` gains `'push' | 'email'`. `readiness` is unchanged for push/email except `template_not_found`/`template_disabled`.
- `pin.ts`: `type PinnedRef = { stepIndex: number; variant: string /* 'default' or the variant key */; templateId: string; version: number }`; `pinDefinition(registry, projectId: string, definition: RuleDefinition): Promise<{ ok: true; definition: RuleDefinition; pinned: PinnedRef[] } | { ok: false; code: 'template_not_found' | 'template_disabled' | 'template_channel_mismatch'; stepIndex: number; variant: string }>`. For each step message with `templateId`: a missing `version` takes the current version (must be enabled); an existing `version` is kept (`getVersion`); the message is rewritten to `{ templateId, version, subject, body, text? }` copied from that version (push: `content.subject/body`; email: `compileEmailContent(content)` from Task 11; until Task 11 an email ref returns `template_channel_mismatch`). Inline messages are untouched.

- [ ] **Step 1: Write failing tests.** `registry.test.ts`: `a push template is created with content and versioned on update`; `an sms template still needs providerRef`; `content and providerRef cannot both be set` (DB check). `pin.test.ts`: `an unversioned push ref pins the current version and copies its text`; `a versioned ref keeps its version after the template changes`; `a disabled template refuses with template_disabled and the step index`; `a push template on an email step is template_channel_mismatch`; `inline messages are returned unchanged`.
- [ ] **Step 2: Run** `bun test --isolate src/templates/registry.test.ts`, then `src/templates/pin.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the migration, the union input (keep `whatsAppMappingMatches` for whatsapp only), `content` in `insertVersion`/`toVersion`, and `pinDefinition`.
- [ ] **Step 4: Run** the three files, then `src/campaign/channel-ready.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): push and email templates are named and versioned`.

### Task 4: Journey lifecycle: start (admin), live edits re-pin, skip reasons

**Files:**
- Create: `packages/marketing/src/api/routes-journeys.ts`
- Modify: `packages/marketing/src/api/routes-dashboard.ts` (PATCH rules), `packages/marketing/src/api/server.ts` (register routes), `apps/start/src/components/marketing/proxy.ts`
- Test: `packages/marketing/src/api/routes-journeys.test.ts`, `apps/start/src/components/marketing/proxy.test.ts`

**Interfaces:**
- Consumes: `pinDefinition` (Task 3), rule row fields (Task 1).
- Produces:
  - `POST /marketing/rules/:id/start` body `{ expectedVersion: number }`. Allowed from `draft` or `paused`. Gates in order: `not_found` 404; `version_conflict` 409; `invalid_transition` 409 (already active); `journey_unconfirmed` 409 with `details { fields: ('trigger'|'goal')[] }` when `unconfirmed` is not empty; pin failures 409 with their code and `details { stepIndex, variant }`. On success, in one transaction, stores the pinned definition, `status = 'active'`, bumps `version`, calls `rulesChanged()`; returns `{ rule, pinned: PinnedRef[] }`.
  - Every path that stores a definition as `active` pins it first (same error mapping): `POST rules` with `status: 'active'` (kept for existing callers, for example `routes.test.ts:496`), PATCH `paused → active` (the existing Resume button in `rules-page.tsx:96`), and a PATCH definition on an `active` rule. Only `draft → active` must go through `/start`: PATCH `status: 'active'` on a draft is refused with 409 `use_start`; body gains `confirmed?: ('trigger'|'goal')[]` which removes those entries from `unconfirmed`; changing `trigger.event` or `goal` in a PATCH also removes the matching entry.
  - `GET /marketing/rules/:id/skips` → `{ reasons: { reason: string; count: number }[] }` from `steps.outcome->>'reason'` where `status = 'skipped'` for that rule's enrollments (codes only).
  - `routesJourneys(deps: { sql: Sql; registry: TemplateRegistry; rulesChanged: () => Promise<void> }): Route[]` (the import and test-send routes of Tasks 6 and 7 are added to this file).
  - Proxy: `rules/[^/]+/start` POST admin; `rules/[^/]+/skips` GET member.

- [ ] **Step 1: Write failing tests.** `routes-journeys.test.ts`: `start pins templates and activates a draft`; `start refuses journey_unconfirmed and lists the fields`; `start with a stale version is version_conflict`; `PATCH status active on a draft is use_start`; `resuming a paused journey pins an unversioned template ref`; `editing an active journey re-pins templates and a running enrollment keeps its old snapshot text` (enroll a student, edit body and template, assert `rule_snapshot` of the existing enrollment unchanged and a new enrollment gets the new pinned text); `skips counts reasons by code`. `proxy.test.ts`: `start needs admin`, `skips allows a member`.
- [ ] **Step 2: Run** `bun test --isolate src/api/routes-journeys.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the routes and the PATCH changes; register in `server.ts` next to `dashboardRoutes`.
- [ ] **Step 4: Run** the file, `src/api/routes.test.ts`, and `bunx vitest run src/components/marketing/proxy.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): journeys are started by an admin with templates pinned at start`.

### Task 5: Workbook and CSV reader

**Files:**
- Create: `packages/marketing/src/journeys/xlsx-reader.ts`, `packages/marketing/src/journeys/csv-reader.ts`, `packages/marketing/src/journeys/xlsx-fixture.ts` (test helper that writes a stored-entry xlsx with `Bun.hash.crc32`)
- Test: `packages/marketing/src/journeys/xlsx-reader.test.ts`, `packages/marketing/src/journeys/csv-reader.test.ts`

**Interfaces:**
- Produces: `type SheetRows = { sheet: string; rows: { rowNumber: number; cells: Record<string, string> }[] }` where `cells` is keyed by the header text of row 1 (trimmed). `readXlsx(bytes: Uint8Array): SheetRows[]` — reads the zip central directory, inflates entries with `node:zlib` `inflateRawSync` (methods 0 and 8 only), sheet names and order from `xl/workbook.xml` + `xl/_rels/workbook.xml.rels`, cells from `t="inlineStr"`, `t="s"` (via `xl/sharedStrings.xml` when present), `t="str"` and plain `<v>`; decodes the five XML entities and numeric character references. Throws `ImportFileError(code)` with `code` in `'not_xlsx' | 'file_too_large' | 'too_many_rows' | 'missing_column'`. Limits (constants): `MAX_IMPORT_BYTES = 512 * 1024` compressed, `MAX_INFLATED_BYTES = 8 * 1024 * 1024` in total, `MAX_IMPORT_ROWS = 2000` per sheet.
- `readCsv(text: string): SheetRows[]` — RFC 4180 (quotes, doubled quotes, CRLF), one pseudo-sheet per distinct `State` column value, named by that value; same limits.

- [ ] **Step 1: Write failing tests.** `xlsx-reader.test.ts` (fixture built in the test, synthetic text only): `reads sheets in workbook order with headers as keys`; `reads inline and shared strings`; `decodes &amp; and &#x0C30;`; `skips empty trailing rows`; `rejects a non-zip as not_xlsx`; `rejects an entry that inflates past the limit` (zip bomb guard); `rejects more than 2000 rows`. `csv-reader.test.ts`: `quoted commas and newlines survive`; `rows group by State into pseudo-sheets`; `a missing State column is reported as missing_column` (return the error through `ImportFileError('missing_column')`).
- [ ] **Step 2: Run** the two files; expect FAIL.
- [ ] **Step 3: Implement** both readers.
- [ ] **Step 4: Run** both files; expect PASS. Then a manual check that is not committed: `bun -e` a one-liner calling `readXlsx` on `C:\Users\Allvy\Downloads\SIA_Exam_Ready_GenZ_Situational_InApp_Journeys_TS_AP.xlsx` printing only sheet names and row counts; expect `Telangana 53`, `Andhra Pradesh 53`, `Journey Rules 18`.
- [ ] **Step 5: Commit** `feat(marketing): read journey workbooks and CSV without new dependencies`.

### Task 6: Import journeys as drafts by journey key

**Files:**
- Create: `packages/marketing/src/journeys/import-plan.ts` (pure), `packages/marketing/src/journeys/import-store.ts`, `packages/marketing/scripts/import-journeys.ts`
- Modify: `packages/marketing/src/api/routes-journeys.ts`, `apps/start/src/components/marketing/proxy.ts`
- Test: `packages/marketing/src/journeys/import-plan.test.ts`, `packages/marketing/src/journeys/import-store.test.ts`, `apps/start/src/components/marketing/proxy.test.ts`

**Interfaces:**
- Consumes: `SheetRows` (Task 5), `zRuleDefinition`, `MAX_DEFINITION_BYTES` (Task 1).
- Produces:
  - Constants in `import-plan.ts`: `REQUIRED_COLUMNS = ['Event Name','Platform','Timing','Message (Content)']`, optional `'Template Idea (Image/Visual)'`, `'Instructions'`; `IGNORED_SHEETS = ['Journey Rules']`; `PLATFORM_CHANNELS = { 'In-App Notification': 'push' } as const`; `TIMING = /^D(\d{1,2})(?:\s+(Immediate|in session|on exit|after exit|confirmation))?$/i`; `CONDITIONAL_TIMING = /^D\d{1,2}\s+on next /i`; `IMPORT_REENTRY = { enabled: true, cooldownSeconds: 21 * 86_400 }`; `GOAL_GUESSES: Record<string, string>` = `registration_started→registration_completed`, `incomplete_registration→registration_completed`, `registration_completed→course_selection_completed`, `home_page_view→course_selection_completed`, `book_sample_viewed→sample_read_continued`, `books_added_to_cart→cart_reviewed`, `cart_abandoned→purchase_success`, `payment_failed→payment_issue_resolved`, `mentor_viewed→mentor_interest_confirmed`, `mentor_notify_click→mentor_interest_confirmed` (no entry for `invalid_pin_otp`: its goal event defaults to `invalid_pin_otp_resolved`).
  - `journeyKeyOf(label: string): string` — lower case, non-alphanumerics collapsed to `_`, trimmed (`'Invalid PIN / OTP'` → `invalid_pin_otp`). The guessed trigger event is the key.
  - `type ImportOptions = { states: Record<string, string> /* sheet name → state value */; journeys?: Record<string, { triggerEvent?: string; goalEvent?: string }>; overwriteEdited?: boolean }`.
  - `type ImportProblem = { sheet: string; row: number | null; code: 'unknown_sheet' | 'sheet_ignored' | 'missing_column' | 'empty_message' | 'unknown_platform' | 'unparsed_timing' | 'conditional_timing' | 'duplicate_timing' | 'message_too_long' | 'too_many_steps' | 'definition_too_large'; column?: string }` (never message text).
  - `type PlannedJourney = { key: string; name: string; definition: RuleDefinition; unconfirmed: ('trigger'|'goal')[] }`.
  - `planImport(sheets: SheetRows[], options: ImportOptions): { journeys: PlannedJourney[]; problems: ImportProblem[] }`. Per state sheet: each row → `(key, delaySeconds = days * 86_400)`; message → variant `options.states[sheet]` with `{ body }`; `note` = `Instructions` (and `Template Idea` prefixed `Visual: `), truncated to `MAX_NOTE_LENGTH`; steps sorted by delay, merged across sheets by delay; no default `template`. `allowedEventProps: []`, `reentry: IMPORT_REENTRY`, `goal: { kind: 'event', event }`. A supplied `triggerEvent`/`goalEvent` is used and not flagged; a guess is flagged in `unconfirmed`.
  - `type ImportAction = 'created' | 'updated' | 'unchanged' | 'skipped_live' | 'skipped_edited'`; `applyImport(sql, projectId: string, planned: PlannedJourney[], options: { overwriteEdited?: boolean; dryRun: boolean }): Promise<{ key: string; action: ImportAction; ruleId: string | null }[]>`. In one transaction, rows locked `FOR UPDATE` by `(project_id, journey_key)`: none → insert `status 'draft'`, `unconfirmed`, `imported_steps_hash`; `active`/`paused` → `skipped_live`, untouched; a draft whose current steps hash differs from `imported_steps_hash` (someone edited the steps; confirming or changing trigger and goal does not count, since import never replaces those) → `skipped_edited` unless `overwriteEdited`; otherwise replace **steps only** (keep name, trigger, goal, reentry, unconfirmed, except entries the request supplied), `unchanged` when the new steps equal the current ones (no version bump), else bump `version` and store the new `imported_steps_hash`. `dryRun` rolls back and reports the same actions.
  - Route `POST /marketing/rules/import` body `{ format: 'xlsx' | 'csv', contentBase64: string, options: ImportOptions, dryRun: boolean }` (decoded size ≤ `MAX_IMPORT_BYTES`) → `{ sheets: string[], journeys: { key, name, action, ruleId, steps: number, variants: string[], unconfirmed }[], problems: ImportProblem[] }` (`sheets` lets the dashboard map sheets to states after a dry run with an empty `states`); `ImportFileError` → 400 with its code. Proxy: `rules/import` POST admin.
  - `scripts/import-journeys.ts <file> --state Telangana=<value> --state "Andhra Pradesh"=<value> [--project <id> --apply]`: dry run by default (planImport only, no DB); prints journey keys, step counts, variant keys and problem codes, never message text.

- [ ] **Step 1: Write failing tests.** `import-plan.test.ts` (synthetic fixture shaped like the workbook: two state sheets with the six real headers, a `Journey Rules` sheet, 3 journeys): `two state sheets become one journey with two variants per step`; `D0 Immediate, D0 on exit and D0 confirmation are delay 0`; `D1 on next failed login is reported conditional_timing and not a step`; `a row with an empty message is reported and the rest of the journey imports`; `an unknown sheet is reported unknown_sheet`; `Journey Rules is reported sheet_ignored`; `an unknown platform is reported with its row`; `a missing Timing column fails the sheet with missing_column`; `guessed trigger and goal are flagged unconfirmed and supplied ones are not`; `no problem carries message text` (serialise problems, assert the fixture's message strings are absent). `import-store.test.ts`: `first import creates drafts`; `re-import with changed text updates the draft by key`; `re-import with equal text is unchanged and keeps the version`; `a draft whose step text was edited in the dashboard is skipped_edited`; `a draft whose trigger and goal were confirmed is still updated by re-import`; `overwriteEdited replaces only steps and keeps the edited trigger and goal`; `an active journey with the same key is skipped_live and its definition is byte-identical afterwards`; `dryRun writes nothing`. `proxy.test.ts`: `import needs admin`.
- [ ] **Step 2: Run** `bun test --isolate src/journeys/import-plan.test.ts`, then `src/journeys/import-store.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `planImport`, `applyImport`, the route and the script.
- [ ] **Step 4: Run** both files; expect PASS. Then the real workbook: `bun scripts/import-journeys.ts "C:\Users\Allvy\Downloads\SIA_Exam_Ready_GenZ_Situational_InApp_Journeys_TS_AP.xlsx" --state Telangana=TS --state "Andhra Pradesh"=AP` (placeholder values until the owner confirms the state values); expect 11 journeys, 51 steps in total (Invalid PIN / OTP has 1, Registration Started 5), two variants per step, exactly 4 `conditional_timing` problems (Invalid PIN / OTP rows 8 and 9 on both sheets) and 1 `sheet_ignored`.
- [ ] **Step 5: Commit** `feat(marketing): import the journey workbook as draft journeys`.

### Task 7: Test send for a journey step

**Files:**
- Create: `packages/marketing/migrations/0018_journey_test_sends.sql`, `packages/marketing/src/journeys/test-send.ts`
- Modify: `packages/marketing/src/api/routes-journeys.ts`, `packages/marketing/src/worker.ts` (run the tick), `apps/start/src/components/marketing/proxy.ts`
- Test: `packages/marketing/src/journeys/test-send.test.ts`, `apps/start/src/components/marketing/proxy.test.ts`

**Interfaces:**
- Consumes: `chooseMessage`'s template type and exported `render` (Task 2), `pinDefinition` (Task 3), `loadChannelConfig`, `entryValues`, `lookupSkipReason` from `ticker.ts`, `getAdapter`, the project's audience source.
- Produces:
  - Table `marketing.journey_test_sends (id uuid PK, project_id text, rule_id uuid, step_index int, variant_key text NOT NULL /* 'default' or a variant key */, profile_id text, status text CHECK IN ('pending','sending','sent','failed','skipped'), reason text NULL, lease_until timestamptz NULL, created_at, sent_at)`, index on `(status, created_at)`.
  - `POST /marketing/rules/:id/test-send { profileId: string, stepIndex: number, variant: string }` → `{ id }` (queues only; same profileId validation and the same limit of 10 an hour per project, 429 `test_send_limit`, as campaign test sends); `GET /marketing/rules/:id/test-sends` → last 20 `{ id, stepIndex, variant, profileId, status, reason, createdAt, sentAt }`. Works for drafts: the step's refs are pinned in memory for the send, nothing is stored.
  - `runJourneyTestSendTick(deps): Promise<number>` — expire `sending` rows past their lease to `failed`/`uncertain`, claim one `pending` row as `sending` with a lease before any call (`FOR UPDATE SKIP LOCKED`), look the student up for the step's channel, render the requested variant (not the student's state), send through `getAdapter(channel)` with idempotency key `test:<id>`, finish `sent`/`failed`/`skipped` with a code. Quiet hours do not apply to test sends (as for campaigns).
  - Proxy: `rules/[^/]+/test-send` POST admin, `rules/[^/]+/test-sends` GET member.

- [ ] **Step 1: Write failing tests.** `the AP variant is sent to a TS student when AP is requested`; `a crash after claiming never sends twice` (row left `sending`, lease expired → `failed` with `uncertain`, adapter called at most once); `an unknown variant is refused 400 unknown_variant`; `the eleventh test send in an hour is 429`; `no phone, email or token is stored on the row` (scan the row). Proxy cases.
- [ ] **Step 2: Run** `bun test --isolate src/journeys/test-send.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the migration, routes, tick, and call the tick from the worker loop next to `runTestSendTick`.
- [ ] **Step 4: Run** the file, `src/worker.test.ts`, `src/engine/pii.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): send a test of any journey step and state variant`.

### Task 8: Push and email campaigns can use a versioned template

**Files:**
- Modify: `packages/marketing/src/campaign/definition.ts`, `packages/marketing/src/campaign/channel-ready.ts`, `packages/marketing/src/campaign/dispatch.ts` (template resolution ~line 280 and message build ~line 501), `packages/marketing/src/campaign/test-sends.ts` (`chooseTemplate`)
- Test: `packages/marketing/src/campaign/definition.test.ts`, `packages/marketing/src/campaign/dispatch.test.ts`, `packages/marketing/src/campaign/test-sends.test.ts`

**Interfaces:**
- Consumes: registry push/email content (Task 3).
- Produces: a push or email campaign `template` is either the current inline object or `{ templateId }` (`zRegistryTemplate`). At start the existing pin path (`channel-ready.ts` readiness, `service.ts` sets `template_version`) applies to these too, with `template_channel_mismatch` when the template's channel differs. Dispatch and test sends build the message from the pinned version's content (`push`: subject/body; `email`: `compileEmailContent` from Task 11 — until Task 11 an email ref fails readiness with `template_mapping_missing`). Inline campaigns behave exactly as before.

- [ ] **Step 1: Write failing tests.** `a push campaign with templateId parses and an inline push campaign still parses`; `starting pins the current version and a later template edit does not change what is sent` (dispatch through the fake FCM, assert body of version 1); `a test send of a push campaign with a ref uses the current version`.
- [ ] **Step 2: Run** the three files one at a time; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files and `src/campaign/service.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(marketing): push and email campaigns can send a pinned template version`.

### Task 9: Journeys tab: drafts, import dialog, start confirmation

**Files:**
- Create: `apps/start/src/components/marketing/journey-import.ts`, `apps/start/src/components/marketing/journey-import-dialog.tsx`, `apps/start/src/components/marketing/journey-start.ts`
- Modify: `apps/start/src/components/marketing/rules-page.tsx`, `apps/start/src/components/marketing/contract.ts` (outside the drift block: `RuleStatus` adds `'draft'`, rule row fields, import/start/skips response types), `apps/start/src/components/marketing/reason-labels.ts`
- Test: `apps/start/src/components/marketing/journey-import.test.ts`, `apps/start/src/components/marketing/journey-start.test.ts`, `apps/start/src/components/marketing/reason-labels.test.ts`

**Interfaces:**
- Consumes: routes of Tasks 4 and 6, `GET audience/dimensions/state/values` (existing) for the state picker.
- Produces:
  - `journey-import.ts`: `fileToBase64(bytes: Uint8Array): string`; `formatOf(fileName: string): 'xlsx' | 'csv' | null`; `defaultStateMapping(sheets: string[], stateValues: { value: string; label: string }[]): Record<string, string>` (a sheet maps to the state whose label equals the sheet name, case-insensitive; otherwise unmapped); `summarizeImport(report): { created: number; updated: number; unchanged: number; skippedLive: string[]; skippedEdited: string[]; problemsBySheet: Record<string, { row: number | null; label: string }[]> }`; `labelImportProblem(code: string): string` with a sentence for every `ImportProblem` code (for example `conditional_timing` → "Depends on something the student does next; not a timed step. Add it by hand if needed.").
  - `journey-start.ts`: `describeStart(rule: Rule, templates: TemplateRow[]): { reactsTo: string; filters: string[]; goal: string; steps: { delay: string; channel: string; variants: string[]; hasDefault: boolean; template?: string /* "name v3" */ }[]; warnings: ('no_default_variant' | 'unconfirmed_trigger' | 'unconfirmed_goal' | 'state_trait_required')[] }`. `state_trait_required` whenever any step has variants (sia-backend must send the `state` trait); `no_default_variant` when a step with variants has no default.
  - `reason-labels.ts`: `no_state_trait` → "The student has no state in the audience API", `no_variant_for_state` → "No message for the student's state and no default message", `template_not_pinned` → "The template was not pinned; restart the journey".
- UI: the rules list shows a `Draft` badge, the `journeyKey` of imported journeys and their unconfirmed fields; admin buttons `Import journeys` (dialog: choose file, map each sheet to a state with a one-line explanation, dry run shows the summary and problems, then Import; checkbox "Overwrite drafts edited here" with its explanation) and `Start` (confirmation lists `describeStart` and every warning; calls `start` with `expectedVersion`; on `journey_unconfirmed` names the fields). Members see these disabled with "Only owners and admins can do this". A journey card lists skip reasons from `GET rules/:id/skips` with the labels above.

- [ ] **Step 1: Write failing tests.** `journey-import.test.ts`: `xlsx and csv names are recognised and others are null`; `Telangana maps to the state labelled Telangana`; `summary groups problems by sheet with labels`; `every ImportProblem code has a label` (the codes from Task 6). `journey-start.test.ts`: `a step with TS and AP and no default warns no_default_variant`; `variants add state_trait_required`; `unconfirmed fields become warnings`; `a pinned ref is described as name and version`. `reason-labels.test.ts`: the three new codes.
- [ ] **Step 2: Run** `bunx vitest run src/components/marketing/journey-import.test.ts src/components/marketing/journey-start.test.ts src/components/marketing/reason-labels.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** helpers, dialog and page changes.
- [ ] **Step 4: Run** the vitest files; expect PASS. `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(dashboard): import the journey workbook and start journeys with a confirmation`.

### Task 10: Journey editor: per-state messages, templates, preview and test send; push templates

**Files:**
- Create: `apps/start/src/components/marketing/step-variants.ts`, `apps/start/src/components/marketing/step-variants-editor.tsx`, `apps/start/src/components/marketing/journey-test-send.tsx`
- Modify: `apps/start/src/components/marketing/rule-editor.tsx` (the step body uses the variants editor; `note` shown read-only under the step; trigger and goal show "Imported guess, confirm" with a confirm checkbox while unconfirmed, sent as `confirmed`), `apps/start/src/components/marketing/template-form.ts`, `apps/start/src/components/marketing/template-editor.tsx`, `apps/start/src/components/marketing/templates-page.tsx`, `apps/start/src/components/marketing/campaign-contract.ts` (template row `content`, channels `push`/`email`)
- Test: `apps/start/src/components/marketing/step-variants.test.ts`, `apps/start/src/components/marketing/template-form.test.ts`

**Interfaces:**
- Consumes: `Step`, `StepTemplate` (contract copy), `GET templates?channel=push`, `POST preview`, journey test-send routes (Task 7).
- Produces (`step-variants.ts`): `DEFAULT_VARIANT = 'default'`; `variantKeys(step: Step): string[]` (`'default'` first when present, then keys sorted); `messageFor(step: Step, key: string): StepTemplate | undefined`; `setMessage(step: Step, key: string, message: StepTemplate | undefined): Step` (`undefined` removes; removing the last message returns the step unchanged); `copyMessage(step: Step, from: string, to: string): Step`; `coverage(steps: Step[], states: string[]): { state: string; missingSteps: number[] }[]` (a default covers every state); `unpinLatest(message: StepTemplate): StepTemplate` (drops `version` and the copied text so the next start pins the newest version). `template-form.ts`: `emptyTemplate` accepts `'push'` (content `{ subject: '', body: '' }`); `templateProblems` reports an empty push body.
- UI: each step has tabs `Default` and one per state value (from the dimension values; a key present in the step but not in the list is still shown), each with inline title/body or a template picker (`name · v<n>`, and "Use newest version" when pinned to an older one); a coverage line under the steps ("AP: all steps; KA: no message in steps 1-5"); preview per tab sends `sample.profile.state = <tab>`; `journey-test-send.tsx` lets an admin pick step, variant and a student id and lists results (poll `JOURNEY_TEST_SEND_POLL_MS = 3000` while any is `pending|sending`). Templates page: a `Push` channel with title, body and the version list.

- [ ] **Step 1: Write failing tests.** `step-variants.test.ts`: `keys list default first`; `removing the last message is refused`; `copy TS to AP`; `coverage reports missing states per step and a default covers all`; `unpinLatest drops version and copied text`. `template-form.test.ts`: `an empty push body is a problem`.
- [ ] **Step 2: Run** the two vitest files; expect FAIL.
- [ ] **Step 3: Implement** helpers and components.
- [ ] **Step 4: Run** the vitest files and `contract.test.ts`; expect PASS. `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(dashboard): edit journey messages per state with templates, preview and test send`.

### Task 11: Email block editor (last)

**Files:**
- Modify: `packages/marketing/src/templates/email-blocks.ts` (replaces the Task 3 placeholder), `packages/marketing/src/templates/pin.ts` (email branch), `packages/marketing/src/campaign/dispatch.ts` and `test-sends.ts` (email ref branch of Task 8), `packages/marketing/src/channels/types.ts` (`RenderedMessage.text?: string`), `packages/marketing/src/channels/email.ts` (`buildMail` adds `text` when set), `packages/marketing/src/engine/ticker.ts` (`render` fills `text` from `template.text` in text mode), `packages/marketing/src/api/routes-dashboard.ts` (`zPreview` also accepts `{ channel: 'email', content }` and returns `{ subject, body, text }`), `apps/start/src/components/marketing/template-editor.tsx`, `apps/start/src/components/marketing/template-form.ts`
- Create: `apps/start/src/components/marketing/email-blocks.ts`, `apps/start/src/components/marketing/email-block-editor.tsx`
- Test: `packages/marketing/src/templates/email-blocks.test.ts`, `packages/marketing/src/channels/email.test.ts`, `packages/marketing/src/campaign/dispatch.test.ts`, `apps/start/src/components/marketing/email-blocks.test.ts`

**Interfaces:**
- Produces (backend `email-blocks.ts`; the dashboard copy mirrors the zod part):
  - `zEmailBlock` discriminated on `type`: `heading { text ≤200 }`, `paragraph { text ≤5000 }`, `button { label ≤80, url }`, `image { src, alt 1..200, width?: int 16..600 }`, `divider {}`. `url` and `src`: `https:` only, ≤2000 chars, no `{{`, no user name or password. Text fields are plain text and may contain `{{profile.<trait>}}` or `{{event.<prop>}}` placeholders.
  - `zEmailContent = z.strictObject({ subject: string 1..300, blocks: z.array(zEmailBlock).min(1).max(MAX_EMAIL_BLOCKS) })` refined: at most `MAX_EMAIL_IMAGES` image blocks. Constants `MAX_EMAIL_BLOCKS = 50`, `MAX_EMAIL_IMAGES = 10`, `MAX_EMAIL_IMAGE_WIDTH = 600`. Type `EmailContent`.
  - `compileEmailContent(content: EmailContent): { subject: string; body: string; text: string }`: `body` is a fixed single-column table layout with inline styles only (no `<style>`, `<script>` or other element `renderTemplate` fails closed on), literal text HTML-escaped with placeholders kept verbatim, images `<img src alt width style="max-width:100%">`, buttons as `<a href>`; `text` has headings and paragraphs as lines, `label: url` for buttons, `[alt]` for images, `---` for dividers. Both are templates for `renderTemplate` (`html` and `text` mode). Deterministic output.
  - Dashboard `email-blocks.ts`: `addBlock(blocks, type, index)`, `moveBlock(blocks, from, to)`, `removeBlock(blocks, index)`, `emailProblems(content): { index: number | null; message: string }[]` (same limits as the backend).
- UI: the email template editor is a block list (add, reorder with buttons usable by keyboard, remove), each block with labelled fields and one-line explanations, a preview from `POST preview` in `<iframe sandbox="" srcDoc>` with the plain-text alternative under it, and the image limits stated next to the add-image button.

- [ ] **Step 1: Write failing tests.** `email-blocks.test.ts`: `a paragraph with <script> is escaped in body and plain in text`; `a profile placeholder renders the trait through renderTemplate html mode`; `the compiled body is not failed closed by the strict renderer` (an allowed event placeholder in a paragraph renders its value); `an http image, an image src with {{, 11 images and width 601 are rejected`; `the text alternative lists the button label and url`. `email.test.ts`: `with text set the fake SMTP server receives multipart/alternative with both parts`. `dispatch.test.ts`: `an email campaign with a template ref sends the pinned version through fake SMTP with html and text`. Dashboard `email-blocks.test.ts`: `move and remove keep the other blocks in order`; `problems match the backend limits`.
- [ ] **Step 2: Run** the backend files one at a time, then the dashboard vitest file; expect FAIL.
- [ ] **Step 3: Implement** the compile, the email branches in `pin.ts`, dispatch and test sends, `text` through `RenderedMessage`, then the dashboard editor.
- [ ] **Step 4: Run** the four test files, `src/template/render.test.ts`, `src/engine/pii.test.ts`; expect PASS. No test reaches a real SMTP host. `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(marketing): build emails from blocks with a plain-text alternative`.

### Task 12: Guide, contract docs and verification

**Files:**
- Modify: `packages/marketing/docs/GUIDE.md`, `packages/marketing/docs/AUDIENCE_CONTRACT.md`, `packages/marketing/AGENTS.md` (one "How it is built" bullet for journeys, import, template versions and email blocks), `packages/marketing/README.md` (migrations 0016 to 0018), `apps/start/src/components/marketing/guide-page.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: GUIDE sections "Journeys from a workbook" (columns, sheet-to-state mapping, timing rules, what is reported, drafts only, re-import rules, confirming the guessed trigger and goal), "Messages per state" (default message, the two skip reasons), "Templates and versions" (pinned at start; "Use newest version"), "Email blocks" (limits, plain-text alternative, fake SMTP only until the provider is set up). `AUDIENCE_CONTRACT.md`: `traits.state` is required for per-state journeys, on every `ok` entry for every channel, equal to the `state` dimension value; without it such steps skip with `no_state_trait` (wording for the sia-backend team; sia-backend is not edited here).

- [ ] **Step 1: Write the docs** above; the dashboard guide page mirrors the GUIDE headings in plain language.
- [ ] **Step 2: Backend suite.** `bun test --isolate` in `packages/marketing` with the test env; expect all PASS. `grep -rn "msg91.com" packages/marketing/src --include=*.test.ts` is empty.
- [ ] **Step 3: Dashboard tests.** `bunx vitest run src/components/marketing` in `apps/start`; expect PASS. `bun run typecheck` at the root; `npx ultracite fix` on every file this plan touched.
- [ ] **Step 4: Real workbook, end to end on the worktree.** Restart the marketing worker as `WORKTREE.md` says. As owner in the dashboard: import the workbook (dry run, then import) and screenshot the summary (11 drafts, 4 conditional-timing rows, Journey Rules ignored); re-import (11 `unchanged`); edit one draft and re-import (`skipped_edited`); confirm trigger and goal on one draft, start it and screenshot the confirmation; re-import (`skipped_live`); send a test of one step for each state variant to the fake FCM. As a member: Import and Start are disabled. As an outsider: the proxy refuses. Query `marketing.rules`, `marketing.steps` and `marketing.journey_test_sends`: no student phone, email, token or state value appears.
- [ ] **Step 5: Commit** `docs(marketing): guide for journey import, state messages, template versions and email blocks`.

## Decisions for the owner (not resolvable from the files)

1. **In-app vs push.** Every workbook row says `In-App Notification` and the `Journey Rules` sheet says "in-app only, not OS pushes"; the spec says push (FCM). The importer maps `In-App Notification` to `push` and reports it. Confirm, or an in-app channel needs its own design.
2. **State values.** The `state` trait does not exist in the lookup today. Which value does sia-backend send (state id, code like `TS`/`AP`, or name)? It must equal the `state` dimension value; the importer's sheet mapping uses it.
3. **Default message.** The workbook has none, so students outside Telangana and Andhra Pradesh get nothing (`no_variant_for_state`). Keep, or make one state's wording the default?
4. **Event names and goals.** The workbook has labels, not production event names, and no per-journey goal. The plan's guesses (key = trigger, `GOAL_GUESSES`, `invalid_pin_otp_resolved`) block Start until confirmed. Provide the real names, or confirm per journey in the dashboard.
5. **Workbook rules not built.** 1/day and 3/week caps, opt-out suppression, cross-journey collisions and priority, payment-status checks, and the conditional Invalid PIN / OTP rows conflict with or exceed the spec (no journey caps, opt-out out of scope, linear journeys). None is built; confirm.
6. **Reentry.** Imported drafts allow re-entry after 21 days. Confirm the window.
