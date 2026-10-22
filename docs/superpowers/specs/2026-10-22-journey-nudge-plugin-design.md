# Journey Nudge plugin: design

## Intent and why

OpenPanel shows where users drop off but does nothing about it. This plugin
closes the loop: an admin defines "event A happened, goal G did not happen
within time T", and the system sends a timed sequence of messages (email,
webhook, mobile push) to bring the user back, and stops as soon as G is
observed. A goal event that reaches the service later than the late-event grace
window (see "Review amendments") cannot cancel a nudge already sent.

It is a **fork add-on that must be adoptable by anyone**, in any industry. The
first user is an ed-tech platform (web, mobile, Windows apps; users log in,
buy a book, read its sections in any order), but nothing in the plugin may know
about books, carts or sections. Those are only event names an admin picks.

The fork must stay mergeable from upstream OpenPanel at any time.

## Goals

- Rule model: `trigger event (+filters)`, `goal`, and an ordered list of
  timed steps. Each step: delay, channel, template, optional limits.
- Three goal kinds, all configurable:
  1. **Event goal**: event G occurs (e.g. `purchase`).
  2. **Inactivity**: the profile goes silent for X after the trigger (e.g. app
     opened, then nothing); each activity resets the timer. See "Rule semantics".
  3. **Set goal**: a set of values has not all been seen, e.g. "event
     `section_opened` with `section_id` in {list} not yet done". The message can
     reference the missing values (`{{missing}}`).
- Sequences ("nudge on day 3, again on day 5"); every pending step is cancelled
  when the goal is met.
- Channels, all shipped in v1: **email**, **webhook**, **Firebase (FCM) push**.
  Channels are adapters behind one interface; adding one is dropping in a file.
  Config per project, secrets encrypted at rest.
- Message templates with variables (`{{profile.firstName}}`,
  `{{event.<prop>}}`, `{{missing}}`), with live preview in the dashboard.
- Everything configurable where it can be: delays, windows, per-user frequency
  caps (max N per period), quiet hours, re-entry policy, which events/properties.
- Identity is the OpenPanel **profile id** (users are logged in). All platforms'
  events for one profile count together.
- Results screen per rule: entered, sent, goal reached after nudge, rate.
- Ship starter templates (rules) so a non-engineer can start: "Added to cart,
  not bought", "Registered, not bought", "Bought, never opened",
  "Opened, specific sections untouched".

## Non-goals (v1)

- AI-written messages (later; template variables only now).
- Branching / free-form journey canvas. Rules are linear.
- Windows desktop push, web push, in-app message widget.
- Replacing OpenPanel's existing team-alert notification rules.
- Anonymous (not identified) users: no email, no token, so not targeted.

## Anti-goals

- Anything that makes upstream merges painful (edits to ingest code, the
  core Prisma schema, or core internals).
- A nudge sent after the goal was observed within the grace window, or a user
  spammed past their cap.
- Hardcoded domain terms (books, carts, sections) anywhere in the plugin.

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

**Own service, own package.** New workspace package `packages/nudge`, run as a
separate process/container (`nudge-worker`), enabled by env. A plain upstream
deploy is unaffected. Written in TypeScript on Bun like the rest of the repo
(chosen so it shares zod, the DB client and `@openpanel/shared/server` crypto;
it does not reuse `@openpanel/email` or core's session code, see "Review
amendments").
Contracts (topic payload, tables, HTTP API) stay language-neutral so the worker
could be rewritten later.

**Event source: Redpanda.** The service runs its own Kafka consumer group on
the events topic (`config.kafka.eventsTopic`, in
`packages/core/src/config.ts` / `modules/ingest/src/kafka.ts`). Read-only; no
change to ingest. It uses `kafkajs` directly with `fromBeginning: false` and
commits offsets only after its writes land. It reads each event only if it
matches the shared interest set (event names of live rules plus enrolled
profile ids). Redpanda auth, if enabled, uses a dedicated read-only credential.
Events are evaluated by event time, and sending is gated on consumer progress
(see "Review amendments").

**Timers: Postgres, not BullMQ.** Pending nudges are rows with `due_at`; a
ticker claims due rows with `FOR UPDATE SKIP LOCKED` inside a short transaction
that only sets a lease (`status='sending'`, `lease_until`), then sends outside
the transaction, then marks the row, so replicas are safe and no lock is held
across an external call.
Chosen because Redpanda has no delayed delivery and BullMQ is upstream's
internal job layer (custom `defineJob`), which would couple the plugin to it.

**Data: own schema, own migrations.** Tables in a **separate Postgres schema
`nudge`** (not `public`: Prisma `migrate dev` treats foreign tables in `public`
as drift and can reset them), plain SQL migrations with the plugin's own runner. Core's `schema.prisma` is
not edited. Tables (names indicative): rules, steps, enrollments (profile, rule,
status, due_at, current step, rule-version snapshot), send log, channel
configs, devices (profile, FCM token, platform), opt-outs, contacts (synced
email and profile attributes), goal/activity facts (event time), seen values
per (profile, set key), reference sets, processed-event ids (TTL), API keys.

**Imports.** Only OpenPanel's public surface: `@openpanel/db`,
`@openpanel/shared/server` (credential encryption, URL safety) and what the
`@openpanel/core` barrel exports. It imports no core session code; dashboard
auth goes through core's tRPC API (see "Decisions that follow from the
verified facts"). `@openpanel/core` exports only `.` and `*.constants`; its
internals are unreachable by design and stay so. `@openpanel/email` is not
used.

**Delivery.**
- *Webhook*: POST to a configured URL with profile id, channel, rendered
  content, rule/step ids, signed with a shared secret. This is how the first
  user routes to their own backend, which owns delivery and consent for them.
- *Email*: the plugin's own adapter (SMTP or provider API) with per-project
  sender config; recipient address comes from the synced contacts table only.
- *FCM*: service-account credentials per project; sends to all of a profile's
  device tokens. Tokens are registered with `POST /nudge/devices` (profile id,
  token, platform), **server-to-server only**: the adopter's backend calls it
  with a dedicated nudge API key. Mobile/desktop apps never call it directly (decided:
  otherwise anyone could attach a device to another user's profile). Invalid
  tokens are pruned.
- Opt-out list and unsubscribe link apply to the built-in email/FCM adapters
  (my call; for webhook the receiver owns consent). The adopter's backend
  syncs contacts (email, name, attributes) and devices to the plugin through
  the same server-to-server API; this is required for built-in email and for
  `{{profile.*}}`, optional for webhook-only use.

**Dashboard: a separate module in `apps/start`.** Pages follow the existing
file routes (`_app.$organizationId.$projectId.<name>...tsx`) plus one sidebar
entry (`components/sidebar-project-menu.tsx`). Screens: Rules, Channels,
Results. **Rule editor is a vertical timeline with a form on each step**
(delay, channel, template, limits), the trigger and goal at the top, and a
visible "goal cancels the rest" marker. Chosen over a sentence-builder because
established tools (Braze Canvas, Customer.io, Klaviyo flows) use visual flows
and it makes the cancel behaviour obvious; linear rules avoid the clutter those
tools get with deep branching.

**Upstream-merge discipline.** Touchpoints in existing files are limited to the
route files (new files; `routeTree.gen.ts` and `bun.lock` regenerate) and the
one sidebar element, listed in `packages/nudge/TOUCHPOINTS.md`. Everything else
is new files.

## Rule semantics (decided in review)

Stated by the user:
- **Goal must match the trigger.** A rule has an optional "match on property"
  (e.g. `book_id`). When set, the goal only counts if its property equals the
  trigger's value, and an enrollment is keyed by (profile, rule, match value).
  Buying two books gives two independent sequences. When unset, enrollment is
  one per (profile, rule) and any goal event counts.
- **Set goals use a reference set.** A per-project registry maps a key (e.g. a
  book id) to its expected values (e.g. section ids). It is editable in the
  dashboard and through an API so the adopter's backend can sync it. The goal
  is met when the profile has done the goal event for every value in the set;
  `{{missing}}` is the remainder. The set does not come from the event payload.
- **Device registration is server-to-server only** (see Delivery).

My calls (not stated by the user; check these):
- **Inactivity goal (revised after review):** a debounce, not a cancel. Each
  activity event pushes the timer forward (`due_at = last_activity + X`); the
  sequence only starts after X of silence. Which events count as activity is
  configurable per rule (all events except an exclude list); the plugin's own
  nudge-response events should be excluded so a nudge cannot reset its own
  timer. The interest set (event names plus enrolled profile ids) is shared
  across replicas (Redis), since every replica sees every profile.
- **No history backfill in v1.** Only events seen after a rule is active count;
  no ClickHouse lookup. Enrollment starts at the trigger and the goal is
  evaluated from then on.
- **Frequency caps:** one cap per profile across all rules, per channel,
  counted under a `pg_advisory_xact_lock` on (project, profile, channel) (a
  row lock on the enrollment does not serialise two rules for one profile). A step
  blocked by the cap is skipped and the sequence continues. A step blocked by
  quiet hours is postponed to the next allowed time.
- **Quiet hours** use one timezone per project.
- **Rule edits** do not affect enrollments already in progress: they keep a
  snapshot of the version they started with.

## Review amendments (from the Opus design review; these supersede earlier text)

Every claim marked (verified) was checked against this repository on
2026-10-22; file references and test results are in "Verified facts" below.
Unmarked items are design decisions, not claims about the repo.

**Correctness of ordering and lag (critical)**
- Events for one profile land on different partitions ((verified) key is
  `deviceId` for client events, `${projectId}:${profileId}` for server events),
  so arrival order is meaningless. Evaluate by **event time**: keep goal and
  activity facts per (project, profile[, match value]) with timestamps,
  independent of enrollments. On enroll and again at send time, check for a
  goal fact at or after the trigger time. Define a late-event grace window
  (offline mobile apps send late events).
- Sends are gated on consumer progress: a step due at T is sent only once the
  consumer has progressed past T (event-time watermark) or group lag is under a
  threshold. (verified) Redpanda retention is 48h, so an outage longer than
  that loses goal events; the service must pause sending rather than send blind.

**Trust and abuse (critical)**
- Browser-sent triggers, goals and profile ids can be forged ((verified) the
  topic payload has no "secret-authenticated" flag). Therefore: HTML-escape
  every variable; each rule allowlists which `{{event.*}}` properties may be
  used and none may appear in a URL/href position; the **email address and
  profile attributes come only from a server-to-server synced contact table**
  (same auth as devices), never from raw event/profile properties; docs state
  that browser-originated triggers can be forged. This makes the adopter's user
  sync a requirement for built-in email and for `{{profile.*}}`.
- Requiring server-originated events per rule is out of scope: core cannot
  tell today and would need an edit.

**Reuse claims that were wrong**
- (verified) `@openpanel/email` only sends fixed internal templates with global
  env SMTP/Resend config and swallows errors; the plugin writes its own
  email adapter (nodemailer or a provider API) with per-project sender config
  and retryable-vs-permanent error classification.
- (verified) `@openpanel/core` exports the `CoreConfig` type,
  `startKafkaEventsConsumer`, `createKafkaEventsConsumer` and
  `IncomingEventPayload`, but there is no public way to build a full
  `CoreConfig` value (`loadConfig` is only in `apps/api`), and
  `startKafkaEventsConsumer` subscribes with `fromBeginning: true`. The plugin uses
  `kafkajs` directly, `fromBeginning: false`, commits offsets only after its
  handler persists, and duplicates the `KAFKA_SASL_*` env parsing.
- (verified) The topic payload is pre-processing: raw `properties` with `__*`
  globals, no session events, project-filtered events still present, events
  heuristically marked `__bot=1` still present (user-agent-detected bots are
  rejected with 202 before the topic), and `profileId` only when the SDK sent it on that event. Triggers fired
  before login carry no profile id and are not targetable.
- (verified) Profiles live in ClickHouse, not Postgres. v1 does not read
  ClickHouse; contact and profile data come from the sync API above.
- (verified) Reusable and should be reused: `encryptCredential` /
  `decryptCredential` (`@openpanel/shared/server`, `ENCRYPTION_KEY`),
  `assertPublicUrl` / `safeFetch`. Dashboard auth does not reuse
  `validateSessionToken` (it needs core's `db` and `config` deps); it forwards
  the cookie to core's tRPC instead. Webhook targets on internal networks
  use an explicit per-deployment allowlist, not disabled SSRF protection.

**Concurrency and delivery**
- Claim due rows with a lease (`status='sending'`, `lease_until`, `attempt`),
  commit, then send, then mark the row; never hold a row lock across an
  external call. Unique (enrollment, step) in the send log; webhooks carry an
  idempotency key. Retry only retryable provider errors.
- Frequency caps take `pg_advisory_xact_lock(hash(project, profile, channel))`
  before counting (row locks on the enrollment do not serialise two rules for
  one profile).
- Dedupe on `event.id`; (verified) `id` is optional on the wire, so fall back to
  a payload hash. Enrollment insert is idempotent via a partial unique index on
  (project, rule, profile, match_value) WHERE active, plus a processed-event
  table with TTL because DLQ replay re-emits events.
- **Re-entry policy (my call):** default ignore a repeat trigger while an
  enrollment is active; after it completes, start a new one only if the rule
  enables re-entry and its cooldown has passed. Both configurable.
- Set goals: keep a per-(profile, set key) seen-values table independent of
  enrollments so `{{missing}}` is right for sections read before enrollment
  (after the rule is active; no history backfill). Reference-set edits apply to
  new enrollments only, consistent with the version snapshot. Compare property
  values as strings; a trigger without the match property is not enrolled.
- Rule lifecycle: the consumer's interest set includes goal/activity events of
  every rule version with live enrollments. Pausing or deleting a rule cancels
  its pending steps (kill switch).

**Devices, webhooks, unsubscribe, dashboard**
- Device and contact sync use a **dedicated nudge API key** (hashed, cached),
  not a tracking client secret. A token is globally unique and moves to the new
  profile on re-register; `DELETE /nudge/devices` exists for logout.
- Webhooks: HMAC over timestamp + raw body, timestamp header with a replay
  window, two active secrets for rotation.
- Unsubscribe: public HMAC-signed endpoint, `List-Unsubscribe` and
  `List-Unsubscribe-Post` headers; separate from core's own unsubscribe table.
- Dashboard API is reached through a new server route file in `apps/start`
  (`routes/api/nudge.$.tsx`, same pattern as the existing `routes/api/config.tsx`)
  that authenticates the user and then calls `nudge-worker`. Auth is decided in
  "Decisions that follow from the verified facts" (the route forwards the
  cookie to core's tRPC `project.getProjectWithClients`; custom header or
  Origin check on mutating calls because the cookie is `SameSite=lax`; the
  route calls the worker with a shared secret, see there).

**Scale and deploy**
- Check the interest set in memory/Redis before any Postgres call; partial
  index on `due_at` WHERE active; send-log retention cap and monthly partitions;
  bound the service's Postgres pool (shared `max_connections`).
- Compose override file plus a new Dockerfile for the worker; note that
  `openpanel init`-generated installs need the override added by hand.

## Verified facts (checked in this repo, 2026-10-22)

Event stream
- Topic and connection come from env `KAFKA_EVENTS_TOPIC`, `KAFKA_BROKERS`,
  `KAFKA_CLIENT_ID`, security from `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD`
  / `KAFKA_SASL_MECHANISM` / `KAFKA_SSL`, `KAFKA_SSL_CA_PATH`,
  `KAFKA_SSL_REJECT_UNAUTHORIZED` (`apps/api/src/config/env.ts`
  `deriveKafkaConfig` / `deriveKafkaSecurity`). The plugin reads the same env
  names, with its own `NUDGE_KAFKA_GROUP` for the group id. The DLQ topic is
  `KAFKA_EVENTS_DLQ_TOPIC` if set, else `${KAFKA_EVENTS_TOPIC}-dlq`; the plugin
  does not consume it.
- Message value is `IncomingEventPayload`
  (`packages/core/src/modules/ingest/src/incoming-event.ts`): `id?` (optional),
  `projectId`, `event` (the `/track` payload plus `timestamp` and
  `isTimestampFromThePast`), `uaInfo`, `geo`, `headers`, `deviceId`,
  `sessionId`. `event.profileId` is present only if the SDK sent it on that
  event (`incoming-event-handler.ts:292`). There is no flag saying the
  producer was secret-authenticated; `clientSecretAuth` only feeds the
  `__bot` markers written into `properties` (`ingest.service.ts:301-308`).
- Partition key is `deviceId` for client events and `${projectId}:${profileId}`
  for server events (random when a server event has no profile id)
  (`ingest.service.ts:309-338`), so one profile spans partitions.
- Core's consumer subscribes with `fromBeginning: true`
  (`consumer.ts:470`); retention is 48h (`self-hosting/redpanda/
  bootstrap.template.yaml:20`, `log_retention_ms: 172800000`).
- Project exclusion filters run after the topic
  (`incoming-event-handler.ts:166, 205, 392`), so the topic still carries
  excluded events. Bot marking (`applyBotSuspicion`) runs before the topic
  (`ingest.service.ts:303, 671`) and adds `__bot` properties; user-agent
  bots are rejected with 202 before the topic (`checkIngestBot`,
  `ingest.routes.ts:125-133`).

Data and auth
- Profiles are not in Postgres (no `Profile` model in `schema.prisma`); they
  are ClickHouse tables.
- `prisma migrate dev` is the dev migrate script and the datasource has no
  `schemas` setting (`packages/db/package.json`, `schema.prisma:16-20`), hence
  the separate `nudge` schema.
- `@openpanel/db` exports `db` and the Prisma/ClickHouse clients via
  `index.ts`. `@openpanel/shared/server` exports `encryptCredential`,
  `decryptCredential`, `assertPublicUrl`, `safeFetch` (also re-exported by
  `@openpanel/core`).
- `validateSessionToken(deps, token)` is exported by core but takes
  `Pick<ServiceDeps,'db'|'config'>` and short-circuits to a demo session when
  `config.demoUserId` is set (`login-session.ts:9, 64-67`).
  `verifyClientSecret` lives in `packages/core/src/shared/client-secret.ts` and
  is not exported; client secrets are scrypt or argon2.
- Session cookie is httpOnly, `SameSite=lax`, path `/`, with domain set to the
  dashboard URL's registrable parent (`.example.com`) unless
  `config.cookies.customDomain` is set; `localhost` and bare IPs get no domain
  (`modules/auth/src/constants.ts`, `cookie-domain.ts`).
- tRPC `project.getProjectWithClients({projectId})` is a protected procedure
  that throws forbidden unless the user has access to the project
  (`modules/project/project.rpc.ts:13-27`).

Reuse limits
- `@openpanel/email` `sendEmail` accepts only keys of its internal template
  registry, reads global `SMTP_*` / `RESEND_API_KEY` / `EMAIL_SENDER`, and
  returns `null` for both failure and "recipient unsubscribed"
  (`packages/email/src/index.tsx:20-130`). Not reusable for admin-authored
  templates.
- `loadConfig` is only in `apps/api/src/config/env.ts:1062`; the `CoreConfig`
  type is exported from `@openpanel/core` (`index.ts:56`) but no public code
  builds a `CoreConfig` value, and the Kafka consumer helpers need one.

Dashboard and deploy
- `apps/start` installs with `linker = "isolated"` (`apps/start/Dockerfile`,
  root `bunfig.toml`), so it resolves only its own `package.json`
  dependencies. `styles.css` is a bare `@import "tailwindcss"` with no
  `@source`, `apps/start` pins `tailwindcss` and `@tailwindcss/vite` 4.1.12,
  and `vite.config.ts` sets no `root`. Test run on 2026-10-22 with those
  exact versions and `vite@7` in a scratch project (`@import "tailwindcss"`,
  no `@source`, the plugin's root set to the app directory): a class used in a
  file inside the app directory (`bg-[#abc123]`) was generated in the built
  CSS; the same kind of class used in a sibling directory outside it
  (`bg-[#fed456]`) was not generated, in both `vite build` and
  `@tailwindcss/cli`. Consequence: UI code placed under `apps/start/src/` is
  styled with no edit to `styles.css`; UI code placed in `packages/nudge/`
  would be unstyled.
- Prisma drift, tested 2026-10-22 with `prisma@6.14.0` (the repo's version)
  against a throwaway Postgres, datasource without `schemas`, one model in
  `public`: after the initial `migrate dev`, adding `public.nudge_rules` made
  the next `migrate dev` report "[+] Added tables - nudge_rules" and "We need
  to reset the "public" schema ... All data will be lost"; adding
  `nudge.rules` in a separate schema `nudge` made the next `migrate dev`
  report "Already in sync, no schema change or pending migration was found."
  So plugin tables go in schema `nudge`, never `public`.
- Gmail and Yahoo require a `List-Unsubscribe` header with RFC 8058 one-click
  support from bulk senders (about 5,000 messages per day or more), honoring
  opt-outs within two days (AWS Messaging blog and Gmail/Yahoo sender
  requirement summaries); transactional mail is generally exempt.
- The JS SDK sends `profileId` on events once `identify` has been called
  (`packages/sdks/sdk/src/index.ts`: `profileId ?? this.profileId` at 214,
  `this.profileId` at 262 and 274, `item.payload.profileId ?? this.profileId`
  at 345, 356, 362; `identify` assigns `this.profileId` at 227). The
  `waitForProfile` option (line 150) is marked `@deprecated` (line 97).
- File routes with server handlers already exist
  (`apps/start/src/routes/api/config.tsx` uses `createFileRoute` with
  `server.handlers`).
- Self-hosted installs get their `docker-compose.yml` rendered by the CLI
  (`self-hosting/cli/src/init/generate.ts:180`, `renderCompose(answers)`), so
  a `docker-compose.nudge.yml` is an override the adopter adds by hand.
- The sidebar edit is one `<SidebarLink exact={false} href={'/nudge'}
  icon={WorkflowIcon} label="Nudges" />` element in
  `apps/start/src/components/sidebar-project-menu.tsx`, next to the existing
  `/notifications` (line 76) and `/integrations` links. The neighbouring links
  are formatted over 5-6 lines (74-85) and CI runs `lint:format`
  (`ultracite check`, root `package.json:85`), so the element is written in
  that multi-line form. `WorkflowIcon` is already imported (line 20), so the
  import block is not edited.
- `packages/core/package.json` `exports` has exactly `"."` and
  `"./modules/*.constants"` (lines 7-10).

## Decisions that follow from the verified facts

- **Dashboard auth (decided):** the service imports no core session code.
  The `apps/start` proxy route (`routes/api/nudge.$.tsx`) forwards the session
  cookie to core's tRPC `project.getProjectWithClients` for the requested
  project; success means the user may access it, failure returns 403. The
  result is cached for a short TTL per (session, project). Demo mode needs no
  special handling because core already returns a demo session. Mutating
  calls require a custom header or Origin check (cookie is `SameSite=lax`).
- **Service-to-service auth:** a dedicated nudge API key (hashed with scrypt
  via `@openpanel/shared/server`, verified result cached in memory) for contact,
  device and reference-set sync.
- **Topic mapping:** profile id is `event.profileId`; events without it are
  ignored for targeting (not enrolled, not counted as goals or activity).
  Match values and set values are read from `event.properties`; the event name
  is `event.name`; event time is `event.timestamp`.
- **Proxy-to-worker trust:** after core's tRPC accepts the cookie, the
  `apps/start` route calls `nudge-worker` with the header
  `x-nudge-proxy-secret` (env `NUDGE_PROXY_SECRET`, compared in constant time)
  plus the verified user id and project id. The worker accepts dashboard
  requests only with that secret and is not exposed publicly.
- **CI and tests, with no edits to existing files** (verified: root
  `package.json:58-61` lists test workspaces explicitly, `vitest.workspace.ts`
  is an explicit list, and `.github/workflows/docker-build.yml:202-205` lists
  Dockerfiles explicitly, so a new package joins none of them; `typecheck`
  auto-discovers workspaces and needs no edit): the plugin's tests run with
  `bun test` inside `packages/nudge`; a new workflow file
  `.github/workflows/nudge.yml` runs typecheck, tests and the `nudge-worker`
  image build. Root `bun run test` does not include the plugin.
- **Conformance gate R21** (verified: `tooling/gates/conformance/
  conformance.constants.ts:145-160` flags same-basename `.ts` files directly in
  `packages/<pkg>/` and in `apps/*/src/utils/`): all plugin source lives under
  `packages/nudge/src/`, and no files are added to `apps/start/src/utils/`.
- **Idempotency key for an event:** `payload.id`, else a hash of
  (projectId, deviceId, event.name, event.timestamp, event.profileId).

## Left to the builder

- Table design details, indexes, send-log retention numbers.
- Template engine choice (must be safe: no code execution, escaped output).
- Exact lease duration, grace window and consumer-lag threshold values
  (configurable; pick sensible defaults).
- Dockerfile and compose override contents for `nudge-worker`.

## Open risks

- A separate consumer group re-reads every event; filter early and measure.
- Marketing messaging carries consent/legal duties (GDPR, unsubscribe,
  frequency). The plugin provides the controls above but adopters are
  responsible for their own compliance.
- Timer and enrollment volume grows with users x steps; dedupe on
  (profile, rule, step) and expire old rows.
