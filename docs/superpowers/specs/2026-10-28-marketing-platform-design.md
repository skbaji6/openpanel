# Marketing platform on OpenPanel: roadmap and design

Status: draft for approval (scope includes the `sia-backend` API work). Builds on the shipped journey-nudge plugin (`packages/nudge`, spec `2026-10-22-journey-nudge-plugin-design.md`). Nothing in this document has been built.

## 1. Intent

The nudge plugin sends behaviour-triggered messages ("did A, did not reach goal G in time T"). Marketing needs more: send a message to a chosen group at a chosen time, reuse templates, see what happened, test variants. The aim is one plugin, renamed **marketing**, that covers journeys (what exists) and campaigns (new), with enough throughput that the plugin is never the slow part of a send.

The owner's platform is ed-tech: about 50,000 students, largest single audience about 20,000, on web, mobile and Windows. The first campaign, in the owner's words: "send the notification to specific university, specific course, specific semester users". The owner wants full control of the selection, from a whole university down to one student. Push is Firebase (FCM). WhatsApp and SMS go through MSG91, which the owner already uses. Email is today a free Gmail SMTP account; the owner has parked email configuration for later. The student id equals the profile id the app sends to OpenPanel.

Decisions of the owner that shape everything below:
- **Student data is not copied** to another location. The marketing workers run in AWS Hyderabad next to the owner's database.
- **The owner's backend, `sia-backend`, serves audiences and contact details through APIs.** It already holds the data. Any API it lacks is developed there, and **the owner has asked for those APIs to be written as part of this work** (Track B below). Nothing is deployed or in production yet, so no data migration is needed anywhere.
- **The backend's own journeys are switched off** once the plugin's journeys go live (section 5.4).
- **All calls to those APIs are secured** (section 5.3).

The module stays generic: any adopter can implement the same contract. "University, course, semester" is the owner's data, not the plugin's vocabulary.

## 2. Goals, non-goals, anti-goals

Goals
- Rename the plugin to **marketing**; journeys become one feature inside it.
- An **audience source** contract: the plugin asks an HTTP API (built by the adopter) which people match a filter and how to reach them, and never stores that personal data.
- An audience builder with full control of selection: filters, hand-picked students, exclusions, live count, preview and "why is this student in or out".
- One-off and scheduled campaigns over **push, WhatsApp and SMS first**, plus email and webhook, sent by a high-throughput engine that never delays journey nudges.
- No self-imposed throttle: the only rate limits are the provider's and the audience API's, set by the operator.
- Later: templates and visual editor, delivery and engagement tracking, A/B tests, branching journeys.

Non-goals
- AI-written messages; a CRM; a preference centre beyond one opt-out per channel; two-way WhatsApp conversations and chatbots (outbound template messages only); billing; replicating the owner's tables; a second marketing UI inside `sia-backend`.

Anti-goals (a failure even if it technically works)
- Any edit to an existing OpenPanel file beyond the one sidebar link and the generated files already allowed (`routeTree.gen.ts`, `bun.lock`), apart from renaming files this plugin itself created (the fork must stay updatable).
- Student emails, names or device tokens persisted in the plugin's database, logs, Redis, templates or send records (ids only).
- The plugin overloading the owner's API or database (it must page, bound its concurrency and back off).
- An audience endpoint that is reachable without authentication.
- A campaign delaying a journey nudge, or the reverse.
- Sending twice to one person for one campaign, or to someone who opted out.
- Claims of throughput without a measurement in this repository.

## 3. Constraints, reuse and topology

- Fork discipline from `packages/nudge/AGENTS.md` carries over: new files only; the allowed edits to existing files are the sidebar link, `routeTree.gen.ts` and `bun.lock`.
- Stack: TypeScript on Bun, Postgres (plain-SQL migrations with the plugin's own runner), Redis, Redpanda via `kafkajs`, dashboard in `apps/start`.
- Reused as is: channel adapters (email, push, webhook; hard send deadlines; invalid-token pruning), the strict template renderer, API-key auth, the dashboard proxy and role rule, the rate limiter, unsubscribe tokens, the `FOR UPDATE SKIP LOCKED` lease pattern, the migration runner and the load-test harness.

### 3.1 Deployment topology

```
Hetzner:   OpenPanel (dashboard, API, Redpanda "events", ClickHouse, its Postgres)
               │ events topic (TLS+SASL, outbound from AWS)      ▲ dashboard proxy (HTTPS + shared secret)
AWS Hyderabad: ▼                                                 │
           marketing worker(s) ── marketing Postgres (+ Redis)
               │ signed HTTPS calls
               ▼
           sia-backend  /internal/audience/**  ── owner's Postgres (read-only role)
```

- Assumed, owner to confirm: OpenPanel and its Redpanda stay at Hetzner, and `sia-backend` runs in AWS next to its database. The worker consumes the events topic across the WAN over an authenticated, encrypted connection initiated from AWS. Events carry ids and event properties, not student records. The WAN carries the whole topic including events the plugin discards; bandwidth is measured in phase 1 and, if too high, a filtered mirror topic is added.
- The dashboard at Hetzner reaches the worker through the existing proxy mechanism (shared secret, unchanged) over HTTPS; the worker's port is open in AWS only to the Hetzner addresses, behind TLS. Unsubscribe links go to the dashboard's pass-through route as today.
- The marketing database lives in AWS next to the workers. By default it is a separate database (`MARKETING_DATABASE_URL`); sharing OpenPanel's database remains supported for small installs but is not this topology.
- The owner's production database is reached only by `sia-backend`, never by the plugin.
- **Tenancy and roles.** As in the shipped plugin, one marketing "project" is one OpenPanel project: every table is keyed by the OpenPanel project id, and the dashboard proxy sends the project id and user id with the shared secret. Role checks (owner and admin change things, members read and preview) are made by the dashboard server before it calls the worker; the worker trusts only the proxy, which is why its port is open only to the Hetzner addresses. Anyone holding the secret on an allowed address can act as the proxy, so the secret is a deployment secret kept out of git and rotated like the audience keys.
- **Event backlog.** Events keep their own timestamps. After a WAN outage or a deploy the consumer resumes from its committed offsets, so the Redpanda retention of the events topic must exceed the longest outage the owner will tolerate (at least 7 days; the owner's setting). A due step that is later than `MARKETING_MAX_LATENESS` (default 24 hours) when the worker gets to it is skipped as `expired` instead of sent, because a late nudge for an exam reminder can be worse than none.

### 3.2 Where the workers run (decided by the owner)

The marketing workers are a **separate service**, not part of `sia-backend`.
- **Marketing worker** (this repo, Bun/TypeScript, `packages/marketing`): journeys, campaigns, the events consumer and the send engine. It has its own Postgres schema and Redis, runs as one or more replicas in AWS Hyderabad, and never connects to the student database.
- **`sia-backend`** gains only the read-only `/internal/audience/**` endpoints (section 5.4) and a flag that disables its own journey service at cut-over. It hosts no marketing workers.
- Why: the plugin stays in the OpenPanel fork without a Java rewrite; a large campaign cannot compete with the student-facing app for CPU, connections or memory; and the worker sees only ids and what the signed API returns, so the "no personal data stored" rule is a hard boundary rather than a convention.
- Cost accepted: one more service to deploy, monitor and secure, and network calls to `sia-backend` that the plugin pages, bounds and backs off on (section 5.2).

## 4. Roadmap

| Phase | Scope | Where |
|---|---|---|
| 1 | Rename to marketing; audience source contract with an HTTP source; secured audience API in `sia-backend` (specified here, built there); reference service; conformance suite; journeys resolve contacts through the source; backend-journey cut-over plan | Section 5 |
| 2 | Audience builder with full selection control, campaigns, send engine; channels in this order: push, WhatsApp, SMS, then email (built and tested against a fake SMTP server; provider configuration is the owner's, later) | Section 6 |
| 3 | Templates and visual email editor | Section 7 (outline) |
| 4 | Delivery and engagement tracking, reports, attribution | Section 7 (outline) |
| 5 | A/B tests, branching journeys | Section 7 (outline) |

Each phase gets its own plan and is reviewed and merged separately. Phase N+1 does not start before phase N is reviewed.

**Two tracks.**
- **Track A (this repo, OpenPanel fork):** the marketing plugin, phases 1 to 5.
- **Track B (`C:\Repos\sia-backend`):** the audience API (section 5.4), written by us, with its own plan, branch and tests in that repo. It follows that repo's conventions and the rules in 5.4 below.

Phase 1's exit is: rename done, contract and conformance suite shipped, the reference service passing them, journeys working through the `http` source against the reference service, and Track B's endpoints passing the same conformance suite. Phase 2 is developed against the reference service and does not wait for Track B, but the first production campaign needs Track B passing.

## 5. Phase 1: rename, audience source, secured API

### 5.1 Rename

Everything user-visible and operational changes together, in one commit series, while nothing is deployed:

| Now | After |
|---|---|
| package `@openpanel/nudge`, dir `packages/nudge` | `@openpanel/marketing`, `packages/marketing` |
| Postgres schema `nudge` | `marketing` |
| env `NUDGE_*` | `MARKETING_*` (old names not kept: no installs exist) |
| HTTP `/nudge/*`, dashboard proxy `/nudge-api/*`, route `/nudge` | `/marketing/*`, `/marketing-api/*`, `/marketing` |
| Redis keys `nudge:*`, consumer group `nudge`, compose service `op-nudge`, `docker-compose.nudge.yml`, `.github/workflows/nudge.yml` | `marketing:*`, `marketing`, `op-marketing`, `docker-compose.marketing.yml`, `.github/workflows/marketing.yml` |
| sidebar label "Nudges" | "Marketing", with tabs Journeys (the existing rules), Campaigns, Audiences, Channels, Results, How it works |
| components `apps/start/src/components/nudge/` | `.../marketing/` |

Done with git renames so history follows. The existing migrations are edited in place to create schema `marketing` because nothing is deployed; if any database does exist at that point (including staging), the builder stops and asks before choosing a rename migration. Tests, docs (README, GUIDE, spec) and the in-app guide change in the same series. The old spec and plan stay as history.

### 5.2 Audience source: the contract

The plugin defines one internal interface, **AudienceSource**, with two implementations:
- `http` (the owner's path): calls the adopter's API described here.
- `stored` (fallback for adopters who cannot build an API): the existing contacts and devices tables fed by the current sync endpoints. It is not extended in this roadmap.

A project selects its source in settings. The `http` contract (JSON over HTTPS; the plugin is always the client):

| Call | Purpose |
|---|---|
| `GET /schema` | Declares the filterable **dimensions**: `key`, `label`, `type` (string, number, date, boolean), `multiValued`, `valuesListable`. The dashboard builds the audience builder from this, so the plugin has no university or course vocabulary. |
| `GET /dimensions/{key}/values?q=&limit=` | Values for dropdowns and search (only if `valuesListable`). |
| `POST /audience/count` | Body: filter tree. Returns `{count, approximate?}`. |
| `POST /audience/members` | Body: filter tree, `cursor`, `limit` (at most 1,000), `fields` (`id` only, or `preview`: id plus a masked display name). Returns members and `nextCursor`. Keyset pagination on a stable id order; a member who changes during a long read may or may not be included (acceptable). |
| `POST /audience/explain` | Body: filter tree and one id. Returns which conditions matched or failed, for the "why is this student in or out" check. |
| `POST /members/lookup` | Body: up to 500 ids and the channel wanted (`push`, `whatsapp`, `sms`, `email`). Returns for each: `email?`, `phone?` (full international format, for example 91XXXXXXXXXX, only for `sms` and `whatsapp`), `devices?[{token, platform}]`, `traits{}` (the values templates use, for example `firstName`), `suppressed?` (true for a person who must not be messaged, for example a withdrawn student), `consent?{whatsapp, sms_promotional}` (optional; used only when the channel's `requireConsent` setting is on, see 6.5), or not found. Called only by the send engine, never for the dashboard. |
| `POST /members/resolve` | Body: up to 200 phone numbers or emails the operator pasted. Returns ids only (and which inputs matched nothing), for the hand-picked list. No contact data comes back. |

- **Filter tree.** The plugin's own JSON: groups joined by AND/OR, depth limit 3; conditions `{dimension, op, values}` with ops eq, in, not_in, gt, lt, between, exists. The reserved dimension `id` supports `in` and `not_in` with at most 1,000 values; longer id lists are handled by the plugin (section 6.1). The plugin only sends dimensions the API declared. The API turns it into parameterised SQL; string-built SQL from the filter is forbidden by the contract.
- **Lookup result per id.** The API returns exactly one entry for every requested id, with a `status`: `ok` (with the address for the channel), `not_found`, `suppressed`, or `unreachable` with a reason (no valid phone, no active device with a token, unverified email, or consent missing when the channel requires it). The plugin records `not_found`, `suppressed` and `unreachable` as skipped with that reason.
- **Personal data handling.** Contact fields exist only in memory for the duration of one batch and are never logged (the existing redaction also covers API responses). Not stored: email, name, tokens, rendered bodies. Stored: the stable id, status and reason per send, and timestamps. Opt-out and suppression records are keyed by id. Unsubscribe tokens carry ids only. Redis never holds contact data. Phone numbers or emails an operator pastes into the picker travel only to `/members/resolve`, are held in memory for that call and are never stored or logged, in the worker or in the dashboard proxy (request bodies of that route are excluded from logs).
- **Resilience.** Per-call timeouts (defaults 10 s, count 5 s); at most `MARKETING_SOURCE_CONCURRENCY` calls in flight (default 4) **across all replicas**, enforced by a Redis-based counting semaphore with expiring slots (a per-process cap would multiply load by the replica count; a slot is taken only after a batch window has closed, so waiting to fill a batch never holds a slot); retry on 5xx and 429 with jittered exponential backoff honouring `Retry-After`; a circuit breaker. If the API is down, campaigns pause and resume on their own and journey steps stay pending; nothing is marked failed because the source was unreachable.
- **Recommended service levels** (in the contract; checked by the conformance suite as warnings): `count` under 2 s, a page of 1,000 members under 2 s, a lookup of 500 under 1 s, at the owner's scale.

### 5.3 Securing the calls

The existing `sia-backend` authenticates users and staff with JWTs checked in `TokenInterceptor`, and Spring Security itself is `permitAll`. A new path is therefore open unless it is guarded explicitly. The audience endpoints, which return personal data, are guarded as follows (the plugin implements the client side; `sia-backend` the server side).

1. **A dedicated machine credential**, not a user or staff token. Every request carries `Authorization: Bearer <key id>.<secret>`, `X-Timestamp`, `X-Nonce` and `X-Signature`, an HMAC-SHA256 over method, path, timestamp, nonce and body hash. The server rejects timestamps older than 60 s and repeated nonces (short-lived cache), so captured calls cannot be replayed.
2. **Deny by default.** A dedicated filter guards `/internal/audience/**`: with no secret configured, or a wrong credential, the answer is 401 and nothing runs. The route is excluded from the user-JWT interceptor only so that this check applies; it is never left unguarded.
3. **Transport.** HTTPS only; the proxy's IP allow-list admits only the worker's address; the endpoints are not published through any public site or CDN; no CORS.
4. **Keys.** Two keys are valid at once, so the secret can be rotated without downtime. Keys live in environment variables or the owner's secret store, never in git. On the plugin side the secret is encrypted like channel secrets and masked in the dashboard.
5. **Limits.** Maximum page size 1,000, maximum body size, and a rate limit on the server; every call is logged by key id, route and counts, never by body or contact value.
6. **Least data.** Only `lookup` returns contact fields, only for the ids passed in (at most 500), never password hashes or any other column. Responses are built from an allow-listed DTO, not the entity. `preview` returns a masked name only.
7. **Read-only database role.** The audience code uses a dedicated Postgres role with read access to the needed tables, not the application's own account.
8. **Negative tests** in the conformance suite, all of which must fail closed: no key, wrong key, stale timestamp, replayed nonce, oversized page, injection strings in filter values, and a request for another column.

### 5.4 The owner's API in `sia-backend`

The owner's backend is `C:\Repos\sia-backend` (Spring Boot 3.3, Java 17, JPA, Postgres). A read-only look found that the data already exists and the missing piece is the API.

| Needed by the contract | What `sia-backend` has today |
|---|---|
| Student to university, college, course, semester, regulation, state | **Exists** on `users`: `university_id`, `college_id`, `course_id`, `semester_id`, `regulation_year_id`, `sub_regulation_year`, `state_id`; plus `enrollments` (`user_id`, `course_id`) for the rare multi-course student. |
| Email, name, phone, active | **Exists** on `users`: `email`, `first_name`, `last_name`, `phone_number`, `active`, `email_verified`. |
| Push tokens | **Exists**: `user_devices.fcm_token` with `active`, `device_os`, `fcm_token_updated_at`. |
| Purchases | **Exists**: `purchases` (`user_id`, `book_id`, `purchase_date`, `expiry_date`, `is_active`, `progress`); `subscriptions` per course. |
| Dimension values | **Exists** as lookup endpoints, but plain lists without search or paging. |
| Targeted notifications | **Exists and overlaps**: `Notification` targets by `universityId`, `courseId`, `regulationId`, `semesterId` and `purchaseStatus`, with send now/later, recurring, a push queue, a Firebase sender, a scheduler and a hard-coded `NotificationJourneyService` (daily cap 2, weekly cap 10). |
| Count, paged members, lookup, explain with parameterised filters | **Missing.** These seven endpoints are the new work. |
| Marketing opt-out field | Not found; the plugin keeps its own opt-out record by id. |

**Purchase status, from the code** (`UserDetailsRepository`): the values are `ALL` (no filter), `PURCHASED` and `NOT_PURCHASED`. *Purchased* means a `purchases` row with `is_active = true` and (`expiry_date` is null or on or after today); *not purchased* is its negation. It is not per book or per course. The audience API exposes this exact predicate as the `purchase_status` dimension so both systems select the same students. Per-book and expired-versus-never-bought dimensions come later from `purchases.book_id` and `expiry_date`.

**Template to follow.** The admin endpoint `GET /getAllUserDetails` already filters by search, `universityIds`, `courseIds`, `regulationIds`, `semesterIds` and `purchaseStatus`, with parameterised multi-id filters and offset paging. The audience API generalises it to the filter tree, keyset paging and a count. Known gap: it matches courses only on `users.course_id`, so a student with a second course in `enrollments` is missed on that course. The audience API's `course` dimension matches either, using `EXISTS` rather than a join so that every student is one row: counts, keyset pages and `/audience/explain` all speak of distinct students, and the conformance suite checks that `count` equals the number of ids paged out.

**Indexes.** The filter columns (university, course, semester, regulation, state, purchase) need indexes for the audience queries, added by a migration in `sia-backend`. Count and keyset paging are measured against production-sized data.

**Who builds it, and how.** We write it (Track B), in `sia-backend`, as a separate plan and a separate branch cut from its `dev` branch (the repo's current branch, clean at the time of writing), never pushed without the owner's say-so. Facts about that repo that the plan must respect: Spring Boot 3.3 on Java 17; Flyway for schema changes (so the index migration is a Flyway file); H2 in tests, which means PostgreSQL-specific SQL in the audience queries needs integration tests against a real Postgres (Testcontainers or the project's existing approach, builder to check); it has no AGENTS.md of its own, so the plan reads its existing controller, service and repository conventions first and matches them; and the only edits to existing classes allowed are `TokenInterceptor` and `SecurityConfig` (to exclude and guard the new route) and the minimal switch that disables `NotificationJourneyService` and its scheduler path behind the journey flag; everything else is new classes, a Flyway migration and tests. The conformance suite from Track A is the acceptance test.

**Backend journeys are switched off** at cut-over, by a configuration flag in `sia-backend` that disables `NotificationJourneyService` and its scheduler path (default unchanged until the cut-over). The plugin's journeys are built to cover the same events: login, registration started, invalid OTP, home view, second app open, buy-now click, checkout view, course bought, topic or LMR click, video started, IQ or PYQ viewed, and 72-hour and 7-day inactivity. The cut-over has a checklist: copy the message wording, run both in shadow with the plugin sending only to a test list, then flip the flag. The admin Notification feature (manual targeted pushes) stays until the owner chooses to replace it with campaigns. Until the cut-over, the plugin's frequency cap does not see the backend's own sends.

### 5.5 Journeys through the source

With the `http` source selected, journeys no longer read stored contact rows: when steps are due, the engine batches them (up to 500 per lookup, waiting at most `MARKETING_LOOKUP_WINDOW_MS`, default 2,000 ms, to fill a batch), calls `/members/lookup`, personalises and sends. A person returned as not found or suppressed has the step recorded as skipped with that reason. The existing sync endpoints and tables remain only for the `stored` source.

This is a refactor of the journey send path, not only a rename. Today the claim query in `src/engine/ticker.ts` joins `contacts` and `devices` and prunes invalid push tokens by deleting device rows. With the `http` source the claim query selects due steps without those joins, the engine groups them, looks up, then personalises; the plan sizes phase 1 accordingly and keeps the existing behaviour for the `stored` source. **Dead push tokens:** the plugin cannot delete rows it does not own, and the audience API stays read-only, so when FCM reports a token invalid the plugin stores only a keyed hash of it (`dead_tokens(project_id, token_hash, seen_at)`, purged after 90 days) and skips that token on later sends. The owner's own pruning in `sia-backend` is unchanged.

### 5.6 Reference audience service

An optional, runnable example (`packages/marketing/examples/audience-api-postgres`, new files, not in the worker image) implements the contract over a Postgres schema through a small mapping file: dimensions to columns or joins, the id column, the contact columns. It shows parameterised filter compilation, the signed-request check of section 5.3, and passes the conformance suite. It exists to prove the contract and to give the `sia-backend` implementation something to compare against. The reference service is TypeScript on Bun over Postgres. The conformance suite is a CLI (`conformance --base-url --key-id --secret`) that can target any URL. It ships a **seed contract**: a small dataset (SQL and JSON) that the target database must be loaded with so the expected counts, pages and explanations are known; Track B loads it into a test Postgres. Track B's plan is written and reviewed in parallel with phase 1.

### 5.7 Database option

`MARKETING_DATABASE_URL` (falls back to `DATABASE_URL`). The runner, pool sizing and health code read the same setting. Tests run against both a shared and a dedicated database.

### 5.8 What this phase leaves out

Replication or connectors of any kind; traits or memberships tables; a generic mapping UI (the API owns the dimension mapping); any change to `sia-backend` other than the audience endpoints, their index migration, the route guard and the journey flag.

## 6. Phase 2: audiences, campaigns, send engine

### 6.1 Audiences: full control of selection

An audience combines four building blocks, freely:

1. **Filters** from `/schema`: state, university, course, regulation, semester, purchase status, and later others. AND/OR groups, depth 3, "is any of" and "is not any of", with value dropdowns from `/dimensions/{key}/values`.
2. **Include specific students**: pick or paste ids (or phone numbers resolved to ids by the API) to add to the result, or to use as the whole audience (a hand-picked list).
3. **Exclude students or groups**: an exclusion list and an exclusion filter, applied last (for example "all semester 3 students of this course except these 40, and anyone who bought").
4. **Look and verify**: the live count with a timestamp; a paged preview of matching students (id and masked name, fetched on demand, never stored); and the "why is this student in or out" check from `/audience/explain`.

Hand-picked and excluded lists are stored as ids only, up to 20,000 ids each. Phone numbers or emails pasted by the operator are turned into ids by `/members/resolve` (ids only come back, so the dashboard never sees contact data). Exclusions of up to 1,000 ids are sent to the API as an `id not_in` condition; larger ones are subtracted by the plugin while materialising. Includes are added by the plugin after the API's pages, and the dashboard shows only counts and masked names. An audience is **dynamic** (re-evaluated at send) or a **snapshot** (ids frozen when saved). If the API is slow or down the builder says so, and the count never blocks saving. Starting a campaign materialises the matching **ids** (never contact details) into the campaign's recipient list by paging `/audience/members` with `fields=id`, applying includes and excludes; later data changes do not alter a running campaign. An optional rule excludes ids that already received the same campaign key, to avoid repeats.

**Precedence.** The audience is (the filter's matches plus the hand-picked ids) minus (the exclusion list and the exclusion filter), so an exclusion always wins. A hand-picked id the source does not know, cannot reach or marks suppressed is not dropped silently: it stays in the recipient list and is recorded as skipped with its reason when the send reaches it. A **snapshot** audience is materialised when it is saved, which needs the API at that moment: if the API is down the dynamic audience still saves, the snapshot save fails with a clear message.

### 6.2 Campaigns

- States: draft, scheduled, running, paused, completed, cancelled, failed.
- A campaign has: an audience, one channel (a multi-channel send is several campaigns), a template (for push and email the same variables as journeys, `{{profile.<trait>}}` from the lookup's `traits`; for SMS and WhatsApp a provider-approved template, see 6.5), a send time (now, or scheduled with a timezone), optional quiet hours, and an optional per-person frequency cap shared with journeys.
- Safety gates: a test send to the creator's own address or device; a mandatory count preview; confirmation naming count and channel for audiences over a configurable size (default 5,000); only owners and admins can start or schedule (existing role rule); members can draft and preview.
- People who are opted out, suppressed, unreachable on the channel or capped are **recorded as skipped with a reason**, never silently dropped.
- Cancel and pause take effect within one dispatch cycle; resume continues where it stopped.
- **Schedules.** A scheduled campaign is due at its time in the campaign's timezone (default Asia/Kolkata), claimed by whichever replica finds it first (not a per-process cron). If no worker is running at that time, the campaign has a setting `ifLate`: send if it is within a number of minutes of the due time (default 60), otherwise mark it `missed` and tell the operator in the dashboard.
- **Email quota.** (Email configuration is deferred by the owner.) The email channel has a required daily quota and a per-second ceiling (no unlimited default for email). A campaign larger than the remaining quota warns before starting and offers to spread the send over several days (recipients stay pending and resume the next day). The operator guide recommends a transactional provider (Amazon SES in Mumbai, Brevo, Mailgun, SendGrid) with SPF, DKIM and DMARC on the sending domain, because free Gmail SMTP (about 500 messages a day, no bulk allowance) cannot carry a 20,000-person campaign. No code change is needed for that, only channel settings.

### 6.3 Send engine

- **Materialise ids once**, in chunks, into `campaign_recipients(campaign_id, profile_id, status, attempt, due_at, ...)`.
- **Dispatch in batches.** Claim a batch with `FOR UPDATE SKIP LOCKED` and a lease, call `/members/lookup` for up to 500 ids, render each message, hand them to the channel adapter, and write a fenced "sent" mark per recipient with a stable idempotency key per campaign and person. Contact details live only in that batch's memory. **Delivery guarantee: at most once for campaigns.** The recipient row is marked `sending` (fenced, with the idempotency key) before the provider call and `sent` after. SMTP and FCM offer no idempotency, so a worker that crashes in between leaves the row `uncertain`: it is not resent automatically, it is counted and shown in the campaign, and the operator can choose to retry those. A lost send is preferred over a duplicate. Rows leased but never marked `sending` return to the pool and are sent normally.
- **Separate lane.** Campaign dispatch has its own claim query, worker pool and concurrency budget; journeys keep theirs. Both share the adapters and the audience-API concurrency cap, with journeys given priority so a campaign cannot starve them.
- **Throughput comes from concurrency, not a throttle.** Per channel: `concurrency` and an optional `ratePerSecond` ceiling set to the provider's quota (required for email, optional for push and webhook). The engine adds no delays of its own. A 429 from a provider backs off that channel only and the recipient stays pending.
- **Channels.** Push: FCM multicast in batches of 500 tokens. WhatsApp and SMS: MSG91 HTTPS calls carrying several recipients per call (the batch size follows MSG91's documented limit, which the builder confirms), pooled keep-alive connections. Email: pooled, reused SMTP connections per replica with pipelining. Webhook: one signed POST per recipient.
- **Scale out.** More replicas claim different batches; no coordination beyond row leases. One running campaign per project by default; extras queue.
- **Progress.** Counters (queued, sent, failed, skipped) updated in batches and shown live.

### 6.4 Targets (to be measured, not assumed)

| Measure | Target | How it is verified |
|---|---|---|
| Plugin overhead per send with a no-op channel and an instant fake API | at least 1,000 sends/s per replica | load script |
| Materialise 20,000 ids from a fake API serving 1,000 per page | plugin time under 5 s on top of the API's own time | load script |
| Journey step latency during a 20,000-person campaign | no worse than 2x the idle median | load script runs both lanes together |
| Behaviour against a slow API (2 s per page) | no timeouts, no duplicates, campaign finishes | load script with a delaying fake API |
| Behaviour when the API fails for 60 s | campaign pauses and resumes, no failed marks, no duplicates | integration test |
| Events consumed across a WAN-like delay (200 ms) | consumer keeps up with the owner's event rate | measured with an injected delay |
| End to end at the owner's scale: 20,000 pushes | finishes within 10 minutes of start, provider speed permitting | load run with a fake FCM at a realistic rate |

If a target cannot be met, this document is updated with the measured value and the reason instead of quoting the target as achieved. Real provider and real API speeds are the owner's to measure on their setup.

### 6.5 Push, WhatsApp and SMS

The owner's focus. Push uses the plugin's existing FCM adapter. WhatsApp and SMS are two new adapters over MSG91's HTTPS API, written by reading `sia-backend`'s working integrations (the WhatsApp bulk-message endpoint with a template name, namespace and positional `header_n`/`body_n` parameters, and the SMS flow endpoint with a template id and variables) and rebuilt in the plugin; `sia-backend`'s code is not called.

- **Provider-approved templates, registered in the settings UI.** India SMS requires a DLT-approved template and WhatsApp business messages require a Meta-approved one, so the message body is fixed at the provider. The owner gets the templates approved and supplies their details; the plugin does not talk to the regulators or check approval. The dashboard's **Settings > Channels** page has a template registry per channel where an owner or admin enters each approved template: a display name, the provider reference (SMS: template id, sender id; WhatsApp: template name, namespace, language, integrated number), the category (`promotional` or `service`), the **approved text** (for preview), and the **variable mapping** from the template's positional variables to the plugin's variables (for example body 1 = `{{profile.firstName}}`). A registered template can be disabled or edited; it is versioned so a running campaign keeps the version it started with. Campaigns and journey steps pick from this registry; the renderer fills variables strictly and fails closed, and a campaign cannot start with a missing mapping or a disabled template. Members can see the registry but not change it.
- **Own credentials.** The plugin uses its own MSG91 auth key and WhatsApp integrated number, stored encrypted in channel settings like other secrets, not `sia-backend`'s key.
- **Consent.** The owner already runs WhatsApp marketing and handles consent on their side, so the plugin does not block on it. Each channel has a setting `requireConsent` (default off). When it is on, the plugin sends only to students whose lookup returns `consent` true for that channel and treats the rest as not contactable (recorded as skipped). Which students are in an audience is the owner's responsibility; the setting is there for when the owner's API can supply a consent flag.
- **Opt-out per channel.** A STOP request or dashboard opt-out applies to the one channel; the plugin keeps the record by id and channel.
- **Quiet hours are configuration.** Quiet hours are a channel setting in the UI (on or off, start time, end time, timezone) with an optional override per campaign. The default is off. A recipient inside the window stays pending and is released at the window end. The owner decides the values; the plugin imposes none.
- **Rate and cost.** `ratePerSecond` is required for SMS and WhatsApp (set to the MSG91 account's limit). The dashboard shows the recipient count and, if the owner enters a per-message price for the channel, an estimated cost before a campaign starts. WhatsApp pricing is per conversation by category and is the owner's to enter.
- **Per-recipient outcomes.** If MSG91's bulk response gives a result per recipient, each recipient is marked accordingly. If it gives only a request id for the whole batch, the request id is stored with every recipient, and a recipient whose outcome the response does not state is marked `uncertain`. The builder confirms the real response shape against MSG91's documentation and a fake server that reproduces it; real credentials and a test number are the owner's to supply later.
- **Inbound STOP replies.** Until the owner says how students opt out of WhatsApp and SMS today, opt-out for these channels comes from the dashboard (including a pasted list) and the API. If MSG91 can post inbound replies to a signed endpoint, a small inbound endpoint is added in phase 2 so a STOP reply is recorded automatically.
- **Delivery status.** The plugin records the provider's accept response and message id per recipient. Delivered, read and failed reports from MSG91 webhooks arrive in phase 4; until then "sent" means accepted by MSG91.

## 7. Phases 3 to 5 (outline only)

- **Phase 3, templates and editor.** Reusable named templates with versions; a block-based visual email editor producing safe HTML through the same strict renderer; image limits; automatic plain-text alternative; test sends.
- **Phase 4, tracking and reports.** Delivery events from the channels (SMTP accept, provider webhooks for bounce and complaint); open pixel and link redirects through the plugin's own domain with signed tokens; per-campaign and per-journey reports; suppression of hard bounces and complaints; revenue attribution by matching a purchase event within a window of the send. High-volume engagement storage moves to ClickHouse behind a small write interface (ids and counters only).
- **Phase 5, A/B and branching.** Split an audience into variants (subject, content, send time) with a winner chosen on a metric after a sample window; journey steps that branch on a condition (opened, clicked) instead of only waiting.

## 8. Verification

Each phase ends only when these have been run and their outputs recorded:

- Package test suite and typecheck, dashboard vitest, `ultracite` on touched files, root `bun run typecheck`.
- **Phase 1:** no `nudge` identifier remains except in historical docs (a grep test); the fork-discipline diff check passes (only new files plus the allowed three); the conformance suite, including the security negative tests of 5.3, passes against the reference service; a test shows that with the `http` source selected no contact field (email, token, name) appears in the marketing database, Redis or logs after journeys and campaigns run (it asserts on every `marketing` table except the `stored` source's contacts and devices tables, which stay unchanged, are unused with the `http` source and hold personal data only for adopters who choose that source); journeys deliver through the `http` source end to end against the reference service backed by a seeded Postgres. The `sia-backend` implementation is accepted when the same conformance suite passes against it, run by us against a local `sia-backend` with a seeded Postgres.
- **Phase 2:** filter validation and hostile-input tests; includes, excludes, snapshot and dynamic audiences resolve correctly; no recipient sent twice under crashed workers, cancelled campaigns and concurrent replicas; the lane-isolation and slow or failing API tests of 6.4; opted-out, suppressed, unreachable and capped people skipped with reasons; WhatsApp and SMS adapters tested against a fake MSG91 server (accepts, rate-limit and error responses, batch splitting, missing template mapping, missing consent); no real message is sent by any test.
- A full pass of the dashboard flows in a real browser as an owner, a member and a no-access user (never run for the journey plugin; required now).

## 9. Calls made by the author (not yet agreed by the owner)

1. The rename is total and immediate, with no backward-compatible `NUDGE_*` names.
2. The `stored` source stays as a small fallback; the `http` source is the owner's path.
3. A dedicated Postgres database in AWS next to the workers is the default topology.
4. ClickHouse is deferred to phase 4 and holds ids and counters only.
5. One channel per campaign.
6. Email has a required daily quota and rate ceiling; push and webhook default to none.
7. One running campaign per project by default; journeys get priority on the audience-API concurrency cap.
8. Marketing and journey messages share one opt-out for now. An opt-out comes only from the unsubscribe link, the dashboard and the API, never from the source; the source can mark a person `suppressed`.
9. A person deleted at the owner's side stops appearing in the source (or is `suppressed`); the plugin keeps only the id and opt-out record.
10. Quiet hours defer: a recipient inside the window stays pending and is released at the window end, in the campaign's timezone.
11. The frequency cap is N messages per person per rolling window across journeys and campaigns (a per-channel option exists; it counts `sent` and `uncertain` rows, never skipped ones), from one ledger table written when a send is marked and checked at claim time (an indexed count, not a shared lock).
12. The seven contract calls, the filter shape, the HMAC scheme and the service-level numbers are my proposal.
13. Hetzner remains the home of OpenPanel and its Redpanda, `sia-backend` runs in AWS, and the worker consumes events across the WAN (to be measured; mirror topic if needed).
14. Confirmed by the owner: nothing is in production, so the rename edits migrations in place and needs no data migration.
15. The builder creates the owner, member and no-access fixtures for the browser pass.
16. Contactable students, from the entity fields: `users.active = true`; for email also `email_verified = true`; for push only devices with `active = true` and a non-empty `fcm_token`. The owner confirms.
17. `purchase_status` follows the existing backend rule exactly (5.4); per-book dimensions wait for a later request.
18. The new endpoints live under `/internal/audience/**` in `sia-backend` as a separate controller set, with the filter and signature check of 5.3.
19. Campaign delivery is at most once (a possible lost send over a possible duplicate); uncertain rows are shown and can be retried by the operator (6.3).
20. The audience-API concurrency cap is global across replicas via Redis; journey lookups wait at most 2 s to fill a batch.
21. Retention: opt-out records are kept until removed; send and frequency-ledger rows are purged after 400 days by the existing hourly purge pattern; the owner confirms for withdrawn students.
22. Hand-picked and excluded lists are capped at 20,000 ids each; phone or email input is resolved to ids by `/members/resolve`, and the dashboard shows only counts and masked names.
23. Unsubscribe and tracking links use one configurable public base URL (`MARKETING_PUBLIC_URL`); a dedicated sending and tracking domain is recommended for deliverability. The owner supplies the domain.
24. WhatsApp and SMS use MSG91 with the plugin's own credentials and owner-approved templates entered in a settings registry (6.5). Consent enforcement and quiet hours are per-channel settings, both off by default; opt-out is per channel.
25. Email is built and tested against a fake SMTP server in phase 2; real provider configuration is the owner's, later.
26. Dead push tokens are tracked by a keyed hash in the plugin and skipped, so the audience API stays read-only (5.5).
27. Late schedules and late journey steps follow explicit rules (`ifLate`, `MARKETING_MAX_LATENESS`); topic retention of at least 7 days is the owner's setting (3.1, 6.2).
28. The conformance suite is a CLI with a seed contract; the reference service is TypeScript on Bun over Postgres (5.6).

## 10. Left to the builder

The Java class layout and test approach of Track B, table and index definitions, column types, the filter tree's exact JSON schema, topic and group naming, the reference service's mapping file format, dashboard layout of the new tabs, error wording, and how to split each phase into tasks.
