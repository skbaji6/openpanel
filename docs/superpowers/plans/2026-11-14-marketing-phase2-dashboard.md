# Marketing Phase 2 Dashboard (plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators can build audiences, register SMS and WhatsApp templates, set up channels, and create, test, launch and watch campaigns from the dashboard's Marketing section.

**Architecture:** New tabs in the existing Marketing section of `apps/start`, all talking to the marketing worker through the existing `/marketing-api/` proxy (every route is already allowed there). Types are copied into a new dashboard contract file guarded by a drift test; all decisions (which buttons a state allows, error wording, form-to-body mapping) live in pure `.ts` helpers with vitest tests, and the React files only render them. One small backend change: push campaigns gain an image and a link.

**Tech Stack:** TanStack Start/Router file routes, React 19, @tanstack/react-query, zod, Tailwind v4, sonner toasts, vitest (pure TS, no jsdom), Playwright for the browser pass; Bun + Postgres in `packages/marketing`.

**Spec:** `docs/superpowers/specs/2026-10-28-marketing-platform-design.md` (sections 6.1, 6.2, 6.5, 8). API facts: `docs/superpowers/plans/2026-11-03-marketing-phase2-engine.md` "Interfaces plan 3 consumes", corrected by the "API facts" section below.

## Global Constraints

- Work in worktree `C:\Repos\openpanel\.worktrees\nudge`, branch `feat/nudge-plugin`. Never push. No `!`, `BREAKING CHANGE`, `[major]`, `[minor]`, `[release now]` in commits. Commit trailer is exactly `Co-Authored-By: Claude <noreply@anthropic.com>`.
- The dashboard never imports from `packages/marketing/src`. Types are copied into `apps/start/src/components/marketing/campaign-contract.ts`. Do not edit the block in `contract.ts` between `MAX_SUBJECT_LENGTH` and `RuleDefinition` (text-compared by `contract.test.ts`).
- The dashboard never shows, stores or logs a phone, email or device token. Members appear as id and masked `displayName` only, fetched on demand.
- No new npm dependency. Use the existing components: `InputWithLabel`, `WithLabel`, `Button`, `Badge`, `Switch`, `Textarea`, `Input`, `Select`, `Table*` from `@/components/ui/table`, `showConfirm` from `@/modals`, `toast` from `sonner`, `FullPageLoadingState`, `FullPageEmptyState`, `IntegrationCardHeader/Footer`, `useMarketingFetch`, `useMarketingQueryKey`, `describeMarketingError`.
- Every form field that is not self-evident carries a one-line explanation under its label (owner's request).
- Admin-only actions (proxy role `admin`: start, schedule, unschedule, pause, resume, cancel, test-send, retry-uncertain, delete, template and settings writes, credentials) are hidden or disabled with the note "Only owners and admins can do this" for other roles, using `useOrganizationAccess(organizationId).isAdmin` (`@/hooks/use-organization-access`). The proxy stays the enforcement.
- Detail and editor views are in-page state driven by a search parameter on the tab route (`?id=<id>`, `?new=1`), not nested routes: `usePageTabs` picks the tab from the last path segment.
- Tests: `bunx vitest run src/components/marketing` in `apps/start`. Backend task: `source <env.sh>` then `bun test --isolate <files>` in `packages/marketing`, one command at a time (the machine is low on memory). `npx ultracite fix <touched files>`, never `npx biome`. `bun run typecheck` at the repo root before each commit.
- Polling intervals are named constants: `CAMPAIGN_POLL_MS = 3000` while state is `running`, `paused` or `scheduled` or a test send is `pending|sending`; no polling otherwise.

## API facts (corrections to the engine plan's interface section, verified in code)

- Template rows are keyed `templateId` (not `id`); a row also carries `projectId, channel, displayName, category, providerRef, approvedText, variables, version, enabled, currentVersion, createdBy, createdAt, updatedAt`.
- `start`/`schedule` body is `{ confirm?: { count, channel, spreadOverDays? } }`; `confirm` always needs `count` and `channel`.
- Error body is `{ error, issues?, details? }`. `confirmation_required` has `details { count, channel }`; `quota_spread_required` has `details { count, remainingToday, daysNeeded }`; `invalid_settings` has `details { issues: string[] }`.
- `POST audience/resolve` → `{ ids: string[], unmatchedPositions: number[] }`. `POST audiences/:id/explain` → `{ id, verdict: 'in'|'out', reasons: ('matched_filter'|'not_matched'|'included'|'excluded_by_list'|'excluded_by_filter')[] }`. `POST audiences/:id/preview` → `{ members: {id, displayName?}[], nextCursor, exclusionsApplied }`.
- `POST campaigns/:id/test-send { profileId }` only queues (`{ id }`); the result arrives in `GET campaigns/:id/test-sends`. Limit 10 an hour (429 `test_send_limit`).
- `draft` cannot be cancelled, only deleted (admin). One active campaign per project (`another_campaign_active`).
- Start gates, in order: `invalid_transition`, `missing_audience`, `audience_snapshot_stale`, `invalid_filter`, `channel_not_configured`, `rate_required`, `quota_required`, `consent_not_supported`, `quota_not_supported`, `template_not_found`, `template_disabled`, `template_mapping_missing`, `template_channel_mismatch`, `count_preview_required` (preview valid 15 min for the same campaign and audience version), `confirmation_required`, `confirmation_mismatch`, `quota_spread_required`, `another_campaign_active`, `template_unavailable`; schedule adds `invalid_send_time`, `schedule_in_past`.
- Full row shapes, body limits and regexes: `.superpowers/sdd/plan3-inventory.md` sections 2 and 3 (git-ignored working file; the code in `packages/marketing/src/api/routes-*.ts` is the authority).

## Review Focus

1. A member (not admin) opens every tab: no admin button is clickable, nothing throws, and reads still work.
2. The audience API is down or not configured: audience and campaign pages say so, the count never blocks saving a dynamic audience, and nothing spins forever.
3. Two people edit the same audience, campaign, template or channel settings: the second save gets `version_conflict` and is told to reload, not silently overwritten.
4. A campaign waits (quiet hours, rate limit, quota, source down, pacing): the detail view says why and until when instead of looking stalled.
5. The operator presses Start twice or the count changed since the preview: the confirm dialog shows the server's count and channel, and a `confirmation_mismatch` re-runs the preview rather than sending.

---

### Task 1: Push campaigns carry an image and a link

**Files:**
- Modify: `packages/marketing/src/campaign/definition.ts`, `packages/marketing/src/campaign/dispatch.ts`, `packages/marketing/src/campaign/test-sends.ts`, `packages/marketing/src/channels/types.ts`, `packages/marketing/src/channels/push.ts`, `packages/marketing/docs/GUIDE.md`
- Test: `packages/marketing/src/campaign/definition.test.ts`, `packages/marketing/src/channels/push.test.ts`, `packages/marketing/src/campaign/dispatch.test.ts`

**Interfaces:**
- Produces: a push campaign's `template` is `{ subject?: string (≤300, the title), body: string (≤20000), imageUrl?: string, link?: string }` (strict). `imageUrl`: `https:` URL, ≤2000 chars, no variables. `link`: ≤2000 chars, parses as a URL whose scheme is not `javascript`, `data`, `file` or `vbscript` (app deep links like `sia://course/12` pass), no variables. Email and webhook campaign templates and all journey templates are unchanged (do not touch `rules/rule.schema.ts`).
- `RenderedMessage` gains `imageUrl?: string` and `data?: Record<string, string>`. The FCM request becomes `{ message: { token, notification: { title?, body, image? }, data?: { link } } }`: `image` only when `imageUrl` is set, `data` only when `link` is set.

- [ ] **Step 1: Write failing tests.** definition: a push draft with `imageUrl: 'https://cdn.example.test/a.png'` and `link: 'sia://course/12'` parses; `imageUrl: 'http://x'`, `imageUrl` containing `{{`, `link: 'javascript:alert(1)'` and an `imageUrl` on an email draft are rejected. push: the fake FCM receives `notification.image` and `data.link` when set, and neither key when unset. dispatch: a push campaign with both fields delivers them to the adapter for a campaign send and for a test send.
- [ ] **Step 2: Run** the three files; expect the new cases to FAIL.
- [ ] **Step 3: Implement.** Split `push` out of the journey-channel branch of the discriminated union in `definition.ts`; pass the two fields from the stored template through the message built in `dispatch.ts` and `test-sends.ts`; map them in `push.ts`.
- [ ] **Step 4: Run** the three files plus `src/engine/pii.test.ts`; expect PASS. `bun run typecheck`.
- [ ] **Step 5: GUIDE**: one paragraph under push ("Title, text, optional image and optional link; the app receives the link as `data.link`").
- [ ] **Step 6: Commit** `feat(marketing): push campaigns can carry an image and a link`.

---

### Task 2: Dashboard foundation: types, errors, role, tabs

**Files:**
- Create: `apps/start/src/components/marketing/campaign-contract.ts`, `campaign-contract.test.ts`, `error-labels.ts`, `error-labels.test.ts`, `reason-labels.ts`, `reason-labels.test.ts`, `use-marketing-role.ts`; routes `apps/start/src/routes/_app.$organizationId.$projectId.marketing._tabs.campaigns.tsx`, `..._tabs.audiences.tsx`, `..._tabs.templates.tsx`; placeholder pages `campaigns-page.tsx`, `audiences-page.tsx`, `templates-page.tsx` (a heading each; later tasks fill them)
- Modify: `apps/start/src/components/marketing/api.ts`, `apps/start/src/routes/_app.$organizationId.$projectId.marketing._tabs.tsx`

**Interfaces:**
- Produces in `campaign-contract.ts`: `CAMPAIGN_CHANNELS = ['push','whatsapp','sms','email','webhook'] as const`, `CampaignChannel`, `PROVIDER_TEMPLATE_CHANNELS = ['sms','whatsapp'] as const`, `CAMPAIGN_STATES`, `CampaignState`, `RECIPIENT_STATUSES`, and interfaces `AudienceRow`, `AudienceCount`, `FilterTree`, `Condition`, `FilterGroup`, `Dimension`, `CampaignRow`, `CountPreview`, `RecipientRow`, `TestSendRow`, `SkipReasonRow`, `Estimate`, `TemplateRow`, `TemplateVersion`, `TemplateInput`, `ChannelSettings`, `ChannelSettingsResponse`, `ProjectSettings`, plus limits `MAX_FILTER_DEPTH = 3`, `MAX_LIST_IDS = 20_000`, `MAX_IDS_PER_CHANGE = 2000`, `MAX_RESOLVE_INPUTS = 1000` and zod schemas `zCampaignDraft` (with the rule: `skipPreviousRecipients` needs `campaignKey`), `zAudienceInput`, `zTemplateInput`, `zChannelSettings` mirroring the backend limits.
- `MarketingApiError` gains `details: Record<string, unknown> | null`; `marketingFetch` fills it from `body.details`.
- `describeMarketingError(error)` looks the code up in `ERROR_LABELS` (`error-labels.ts`), one plain sentence per code for every code in "API facts" plus `version_conflict` ("Someone else changed this. Reload and try again."), `audience_in_use`, `ids_limit`, `not_snapshot`, `snapshot_too_large`, `freeze_in_progress`, `source_not_configured`, `source_not_http`, `source_unavailable`, `source_auth_failed`, `source_error`, `invalid_audience`, `invalid_campaign`, `not_draft`, `mapping_mismatch`, `channel_immutable`, `invalid_settings`, `channel_unavailable`, `test_send_limit`, `invalid_profile_id`; unknown codes fall back to the code.
- `reason-labels.ts`: `labelDispatchError(code: string): string`, `labelStateReason(code: string): string`, `labelRecipientReason(reason: string): string` (exact codes from the engine plan's interface section; prefixes `unreachable:`, `msg91 `, `fcm `, `smtp `, `http ` produce "Provider answered <rest>" style text; unknown → the raw reason), `labelSettingsIssue(code)`.
- `useMarketingRole(): { isAdmin: boolean }` from `useOrganizationAccess(useAppParams().organizationId)`.
- Tabs, in order: `campaigns` "Campaigns", `audiences` "Audiences", `rules` "Journeys" (still the index route), `templates` "Templates", `channels` "Channels", `results` "Results", `guide` "How it works". Header description: "Campaigns and journeys that message students by push, WhatsApp, SMS or email".

- [ ] **Step 1: Write failing tests.** `campaign-contract.test.ts`: reads `packages/marketing/src/campaign/state.ts`, `campaign/recipients.ts`, `channels/settings.ts` and `audience/contract.ts` as text (the way `contract.test.ts` does) and asserts every state, recipient status, campaign channel and filter op named there is in the dashboard constants; `zCampaignDraft` rejects `skipPreviousRecipients: true` without `campaignKey` and a push `imageUrl` that is not https. `error-labels.test.ts`: every code listed above has a label that is not the code; `describeMarketingError(new MarketingApiError(409,'version_conflict',[],null))` is the reload sentence. `reason-labels.test.ts`: `labelRecipientReason('unreachable:no_live_token')`, `'msg91 311'`, `'no_phone'`, `'deadline'` and an unknown reason; every `dispatchError` and `stateReason` code of the engine plan has a label.
- [ ] **Step 2: Run** `bunx vitest run src/components/marketing`; expect FAIL.
- [ ] **Step 3: Implement** the files, routes and tab list; regenerate the route tree the way the repo does (start `bun run dev` in `apps/start` once, or the router generate script in its `package.json`).
- [ ] **Step 4: Run** vitest (all marketing tests incl. `contract.test.ts`, `proxy.test.ts`), root `bun run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): marketing gains campaigns, audiences and templates tabs`.

---

### Task 3: Channel setup: SMS and WhatsApp credentials, sending settings

**Files:**
- Create: `apps/start/src/components/marketing/channel-settings-card.tsx`, `channel-settings.ts`, `channel-settings.test.ts`
- Modify: `apps/start/src/components/marketing/channels-page.tsx`

**Interfaces:**
- Consumes: `GET|PUT channels/:channel` (`{ config }`), `GET|PUT channels/:channel/settings` (`{ settings, expectedVersion }`), `ChannelSettings`, `labelSettingsIssue`.
- Produces: `channel-settings.ts` exports `CREDENTIAL_FIELDS: Record<CampaignChannel, { key, label, help, secret, required }[]>` (sms: `authKey`, `baseUrl`, `defaultCountryCode`; whatsapp: `authKey`, `integratedNumber`, `baseUrl`, `defaultCountryCode`; existing email, webhook, push fields unchanged), `settingsFieldsFor(channel): ('concurrency'|'ratePerSecond'|'quietHours'|'requireConsent'|'pricePerMessage'|'dailyQuota'|'quotaTimezone')[]` (`requireConsent` only sms and whatsapp; `dailyQuota` and `quotaTimezone` only email), `toSettingsBody(form): ChannelSettings` (empty number → `null`), `settingsProblems(form, channel): string[]`.
- The Channels page shows one card per `CAMPAIGN_CHANNELS` entry: credentials (existing card, now also sms and whatsapp), then "Sending settings" with a status line built from `issues` ("Ready" or the labelled issues), then the existing API keys and audience source cards. Help texts: base URL "Leave empty for MSG91's own address"; default country code "Added to 10-digit numbers. India is 91"; rate "Messages per second your MSG91 account allows. Required"; concurrency "How many sends run at once"; quiet hours "Messages due inside this window wait until it ends"; consent "Send only to students the audience API marks as consenting"; price "Used only for the cost estimate before a campaign starts".

- [ ] **Step 1: Write failing tests** for `toSettingsBody` (blank rate → `null`, `'12.5'` → `12.5`), `settingsFieldsFor('push')` (no consent, no quota), `settingsFieldsFor('email')` (has quota), `settingsProblems` (quiet hours enabled with equal start and end; rate ≤ 0; currency not three capitals).
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement** the helpers and the card; a `version_conflict` on save refetches and tells the user.
- [ ] **Step 4: Run** vitest and typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): sms and whatsapp setup and per-channel sending settings`.

---

### Task 4: Template registry

**Files:**
- Create: `apps/start/src/components/marketing/template-form.ts`, `template-form.test.ts`, `template-editor.tsx`
- Modify: `apps/start/src/components/marketing/templates-page.tsx`

**Interfaces:**
- Consumes: `GET templates?channel=`, `POST templates`, `PUT templates/:id` (`expectedVersion` = row `currentVersion`), `POST templates/:id/enable|disable`, `POST templates/:id/preview { sample: { profile } }`, `GET audience/schema` is NOT used here (variables are free `{{profile.<trait>}}` text).
- Produces: `template-form.ts` exports `emptyTemplate(channel): TemplateInput`, `whatsappSlotsFor(approvedText: string): string[]` (`'Hi {{1}}, {{2}}'` → `['body_1','body_2']`), `templateProblems(input): { path: string, message: string }[]` (regexes from "API facts"/inventory 2.5: flow id, sender id six capitals, template name, namespace, language, slots, each value only `{{profile.<trait>}}` placeholders and plain text), `toTemplateBody(form)`.
- Page: a channel switch (SMS, WhatsApp), a table (name, category, provider reference, version, enabled badge), "Add template" and per-row Edit, Enable/Disable (admin only). The editor shows provider fields for the channel with help text (SMS "Flow ID from MSG91's flow"; WhatsApp "Template name exactly as approved by Meta", "Namespace from MSG91", "Language code, for example en"), the approved text, one row per variable (WhatsApp rows are generated from the approved text with `whatsappSlotsFor`; SMS rows are added by name, for example `var1`), and a "Preview" button showing the server's rendered text or its failure. Channel cannot change on edit.

- [ ] **Step 1: Write failing tests** for `whatsappSlotsFor` (ordering, duplicates collapse, none), `templateProblems` (bad sender id `abc123`, slot `body_0`, value `{{event.x}}` rejected; a valid SMS and a valid WhatsApp input give no problems), `toTemplateBody` (drops empty optional `senderId`, `integratedNumber`).
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** vitest and typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): sms and whatsapp template registry`.

---

### Task 5: Audience builder

**Files:**
- Create: `apps/start/src/components/marketing/audience-filter.ts`, `audience-filter.test.ts`, `filter-builder.tsx`, `audience-editor.tsx`, `audience-lists.tsx`, `audience-verify.tsx`
- Modify: `apps/start/src/components/marketing/audiences-page.tsx`

**Interfaces:**
- Consumes: all `audience/*` and `audiences/*` routes of the inventory's 2.1; `Dimension`, `FilterTree`, `AudienceRow`, `AudienceCount`.
- Produces: `audience-filter.ts` exports `emptyGroup(): FilterGroup`, `depthOf(tree): number`, `canNest(tree, path): boolean` (false at `MAX_FILTER_DEPTH`), `opsFor(dimension: Dimension): Op[]` (string: `in`, `not_in`, `exists`; number and date: `eq`, `gt`, `lt`, `between`, `exists`; boolean: `eq`, `exists`), `OP_LABELS` (`in` "is any of", `not_in` "is not any of", …), `filterProblems(tree, dimensions): string[]` (unknown dimension, empty values, `between` without two values), `normalizeFilter(tree): FilterTree | null` (drops empty groups; an empty tree is `null`), `parseIdInput(text: string): string[]` (split on newline, comma, whitespace; trimmed; de-duplicated; order kept), `chunkIds(ids, MAX_IDS_PER_CHANGE)`, `describeCount(count: AudienceCount): string`.
- Page states: list (name, mode, counts of hand-picked and excluded ids, "in use" badge, snapshot date); `?new=1` and `?id=` open the editor. Empty state when the source is not an HTTP source (`source_not_http`/`source_not_configured`): "Connect the audience API on the Channels tab first" with a link.
- Editor sections: (1) name and mode (dynamic "re-checked when the campaign starts" / snapshot "frozen now"); (2) "Who is in" filter builder with AND/OR groups to depth 3, value picker from `audience/dimensions/:key/values?q=` (debounced with `useDebounceValue`) when `valuesListable`, free input otherwise; (3) "Add specific students" and (4) "Always leave out": paste ids, phone numbers or emails → `audience/resolve` in chunks of `MAX_RESOLVE_INPUTS` → only the count of matched ids and the count unmatched are shown, the pasted text is cleared from state after resolving, then `POST audiences/:id/ids` in chunks of 2000 with the returned `version` threaded through; "Clear list" with confirm; (5) "Leave out by filter" (`excludeFilter`); (6) "Check": Count button (count, `approximate` marker, time), paged preview table (id, masked name; note when `exclusionsApplied` is false: "The leave-out list is larger than the preview applies"), and "Why is this student in or out" (id input → verdict and reasons in words); for snapshot audiences a "Freeze now" button and a "changed since freeze" warning when `snapshotVersion !== version`.
- Saving never waits for a count. Source errors on count, preview or explain show inline in section 6 only. Delete (admin) reports `audience_in_use`.

- [ ] **Step 1: Write failing tests** for every export of `audience-filter.ts` (depth limit, `normalizeFilter` of nested empty groups → `null`, `parseIdInput('a, b\n\na  c')` → `['a','b','c']`, `opsFor` per type, `filterProblems` cases, `chunkIds` of 4,500 ids → 2000, 2000, 500).
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement** helpers, then the components.
- [ ] **Step 4: Run** vitest and typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): audience builder with filters, hand-picked lists and checks`.

---

### Task 6: Campaign list and draft editor

**Files:**
- Create: `apps/start/src/components/marketing/campaign-form.ts`, `campaign-form.test.ts`, `campaign-editor.tsx`, `push-message-editor.tsx`, `campaign-list.tsx`
- Modify: `apps/start/src/components/marketing/campaigns-page.tsx`

**Interfaces:**
- Consumes: `GET|POST campaigns`, `GET|PATCH|DELETE campaigns/:id`, `GET audiences`, `GET templates?channel=`, `GET channels/:channel/settings`, `zCampaignDraft`, Task 1's push template.
- Produces: `campaign-form.ts` exports `emptyCampaign(): CampaignForm`, `toDraftBody(form): unknown` (push → `{ subject?, body, imageUrl?, link? }`, email/webhook → `{ subject?, body }`, sms/whatsapp → `{ templateId }`; blank optional strings omitted; cap and quiet-hours override `null` when off), `fromRow(row: CampaignRow): CampaignForm`, `campaignProblems(form): { path, message }[]` (via `zCampaignDraft` plus: scheduled needs `sendAtLocal`), `pushPreview(form): { title: string | null, body: string, imageUrl: string | null }`, `STATE_BADGE: Record<CampaignState, { label, variant }>`.
- List: table of name, channel, state badge, audience name, progress (`sent`/`queued` when started), send time, created. Row click → `?id=`. "New campaign" → `?new=1`.
- Editor (drafts only; other states open Task 8's detail): name; channel (cannot be changed after the first save without confirming that the message is cleared); audience select with a link to create one; message by channel: push → `PushMessageEditor` (title, text, image URL "https link to a picture shown in the notification", link "opened when the student taps the notification, for example sia://course/12", insert-variable hint `{{profile.firstName}}`, a phone-style preview from `pushPreview`); sms/whatsapp → select from enabled registry templates showing the approved text, with a link to the Templates tab when empty; email → subject and HTML body (plain textarea; the visual editor is a later phase) and webhook → body; "When": now or scheduled (`sendAtLocal`, timezone default Asia/Kolkata, "If the system is down at that time, still send when it is no more than N minutes late", default 60); "Quiet hours for this campaign" (use the channel's, or override); "Limit per student" (max messages in a period); "Campaign key" with "Skip students who already received a campaign with this key". Save uses `expectedVersion`; `not_draft` and `version_conflict` reload.

- [ ] **Step 1: Write failing tests** for `toDraftBody` (each channel; blanks omitted), `fromRow` round trip, `campaignProblems` (skip-previous without key; scheduled without time; push image not https), `pushPreview`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** vitest and typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): campaign list and draft editor with a push message editor`.

---

### Task 7: Check, test and launch

**Files:**
- Create: `apps/start/src/components/marketing/campaign-launch.ts`, `campaign-launch.test.ts`, `campaign-launch-panel.tsx`
- Modify: `apps/start/src/components/marketing/campaign-editor.tsx`

**Interfaces:**
- Consumes: `POST campaigns/:id/count-preview`, `POST campaigns/:id/estimate`, `POST campaigns/:id/test-send`, `GET campaigns/:id/test-sends`, `POST campaigns/:id/start|schedule|unschedule`, `MarketingApiError.details`, `labelSettingsIssue`, `labelRecipientReason`.
- Produces: `campaign-launch.ts` exports `PREVIEW_TTL_MS = 900_000`, `previewIsFresh(row: CampaignRow, now: number): boolean` (same `version` and `audienceVersion`, younger than the TTL), `launchSteps(row, estimate | null, now): { key: 'saved'|'audience'|'count'|'channel'|'test', done: boolean, note: string }[]`, `confirmFromError(error: MarketingApiError, sent: Confirm | undefined): { kind: 'confirm', count, channel } | { kind: 'spread', count, remainingToday, daysNeeded, channel } | { kind: 'recount' } | null` (`confirmation_required` → confirm; `quota_spread_required` → spread, keeping the earlier `count` and `channel`; `confirmation_mismatch` and `count_preview_required` → recount), `formatDuration(seconds)`, `formatCost(cost)`, `testSendIsPending(rows)`.
- Panel (below the saved draft): "1. Count" (runs count-preview; shows count, breakdown and time; "Count again" when stale); "2. Estimate" (time at the channel's rate, cost when a price is set, email quota line, labelled issues with a link to Channels); "3. Send a test" (a student id field, "Sends this campaign's message to that one student", then the test-send table polled every `CAMPAIGN_POLL_MS` while any row is `pending|sending`, statuses and reasons labelled); "4. Start now" or "Schedule" (admin). On `confirm`: `showConfirm` "Send to {count} students by {channel}?" then resend with `confirm`. On `spread`: "Only {remainingToday} emails are left today. Spread over {daysNeeded} days?" then resend with `spreadOverDays: true`. On `recount`: run the count again and tell the user the number changed. Any other code → the labelled error. A scheduled campaign shows "Unschedule".

- [ ] **Step 1: Write failing tests** for `previewIsFresh` (stale by time, by campaign version, by audience version), `confirmFromError` (each kind; spread after a confirm keeps count and channel), `launchSteps`, `formatDuration(3725)` → "1 h 2 min", `testSendIsPending`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** vitest and typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): count, estimate, test and launch a campaign`.

---

### Task 8: Watch and operate a campaign

**Files:**
- Create: `apps/start/src/components/marketing/campaign-status.ts`, `campaign-status.test.ts`, `campaign-detail.tsx`, `campaign-recipients.tsx`
- Modify: `apps/start/src/components/marketing/campaigns-page.tsx`

**Interfaces:**
- Consumes: `GET campaigns/:id`, `POST campaigns/:id/pause|resume|cancel|retry-uncertain`, `GET campaigns/:id/recipients?status=&cursor=&limit=`, `GET campaigns/:id/skip-reasons`, reason labels.
- Produces: `campaign-status.ts` exports `actionsFor(state: CampaignState, isAdmin: boolean, counters): ('pause'|'resume'|'cancel'|'retryUncertain'|'delete'|'edit'|'unschedule')[]` (draft: edit, delete; scheduled: unschedule, cancel; running: pause, cancel, retryUncertain when `uncertain > 0`; paused: resume, cancel, retryUncertain when `uncertain > 0`; completed: retryUncertain when `uncertain > 0`; none for non-admins except edit on a draft), `progressOf(counters): { total, done, percent }`, `waitingLine(row: CampaignRow, now: number): string | null` (`dispatchError` label plus "until HH:mm" from `dispatchRetryAt`; `dispatchRetryAt` set with no error → "Pacing to the channel's rate"; `materializeState: 'in_progress'` → "Building the recipient list"), `outcomeLine(row): string | null` (`missed` → "Not sent: the system was not running within {ifLateMinutes} minutes of the planned time"; `failed`/`cancelled` → labelled `stateReason`), `shouldPoll(row): boolean`.
- Detail: header (name, channel, state badge, started and finished times), progress bar with the five counters, the waiting or outcome line, action buttons with confirms ("Cancel stops the rest; already sent messages cannot be recalled"), an "Uncertain" explanation ("The provider may or may not have accepted these. Retrying can send a second message.") shown with the retry button, "Why some were not sent" table from skip-reasons (status, labelled reason, count), and a recipients table with a status filter and "Load more" (student id, status, labelled reason, attempts, provider reference, time). Polls every `CAMPAIGN_POLL_MS` while `shouldPoll`.

- [ ] **Step 1: Write failing tests** for `actionsFor` (every state × admin/member), `progressOf` (zero total), `waitingLine` (quiet hours with a time; pacing; none), `outcomeLine('missed')`, `shouldPoll`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** vitest and typecheck; expect PASS.
- [ ] **Step 5: Commit** `feat(dashboard): live campaign progress, reasons and operator actions`.

---

### Task 9: Guide, browser pass and phase checks

**Files:**
- Create: `apps/start/e2e/marketing-campaigns.spec.ts`, `packages/marketing/scripts/dev-stack.ts`
- Modify: `apps/start/src/components/marketing/guide-page.tsx`, `packages/marketing/docs/GUIDE.md`, `packages/marketing/README.md`

**Interfaces:**
- Produces: `bun scripts/dev-stack.ts` (in `packages/marketing`): starts, in one process, the fake audience API of `examples/audience-api-postgres` seeded with 50 students, the fake MSG91 (`src/channels/fakes/msg91-server.ts`) and the fake FCM, prints their URLs and the settings to enter (audience source base URL and secret, MSG91 base URL to put in `MARKETING_WEBHOOK_ALLOW_HOSTS`), and exits on Ctrl+C. It sends nothing real.
- The e2e spec is skipped unless `MARKETING_E2E=1` (it needs the worker and the dev stack running). Flow as the seeded admin: connect the audience source; save SMS credentials and settings; register an SMS template; create an audience with one filter, count it, preview it; create an SMS campaign, count, estimate, queue a test send and see it reach `sent`; start; watch it reach `completed` with `sent` equal to the count; open recipients. As a member (created in the spec through the organization invite flow used by `e2e/org-members.spec.ts`): the Campaigns, Audiences and Templates tabs load, there is no Start, Delete or Add template button, and a direct `POST /marketing-api/campaigns/<id>/start` answers 403. As a signed-in user outside the organization: the marketing route does not render data and `GET /marketing-api/campaigns` answers 403.
- "How it works" gains sections: Campaigns step by step, Audiences, Templates, what each state and each waiting reason means, what "uncertain" means, quiet hours, limits, and one line on concurrency ("one campaign per project runs at a time; others wait").

- [ ] **Step 1: Write** `dev-stack.ts` and the e2e spec.
- [ ] **Step 2: Start** Postgres/Redis (`bun run dock:up` if not up), the worker (`bun run --filter @openpanel/marketing start` with `MARKETING_PROXY_SECRET` equal to `apps/start/.env.local`), `dev-stack.ts`, and the dashboard; run `MARKETING_E2E=1 bunx playwright test e2e/marketing-campaigns.spec.ts` in `apps/start`. Expected: PASS. Save three screenshots (campaign detail completed, audience editor, member view) into the task report folder and look at them.
- [ ] **Step 3: Write** the guide page, GUIDE and README sections (operator steps with the same wording as the UI).
- [ ] **Step 4: Final verification**, each output recorded in the report: `bunx vitest run` in `apps/start`; `bun test --isolate` in `packages/marketing` (with the test env); root `bun run typecheck`; `packages/marketing/scripts/check-fork.ts` and `check-rename.ts`; `npx ultracite fix` on every file this plan touched.
- [ ] **Step 5: Commit** `docs(marketing): campaign operator guide and browser checks`.

## Self-review notes

- **Spec coverage.** 6.1 filters, includes, excludes, count, preview, explain, dynamic and snapshot (Task 5); 6.2 campaign fields, test send, mandatory count, confirmation over the threshold, admin-only start, schedule and `ifLate`, missed, email quota spread (Tasks 6 to 8); 6.5 template registry in settings, own credentials, consent, quiet hours, rate and price (Tasks 3, 4); owner's push editor with image (Tasks 1, 6); 8 browser pass as owner, member and no-access (Task 9).
- **Not in this plan:** project-wide journey caps UI (`settings` route, journeys only), reference sets UI, the visual email editor (phase 3), delivery reports and click tracking (phase 4).
- **Calls made here:** push `link` is delivered as FCM `data.link` (the app must read it); image and link take no variables; detail views use a search parameter instead of nested routes; the e2e spec is opt-in because it needs the worker.
