# Marketing platform on OpenPanel: roadmap and design

Status: draft for approval (revision 2: no user data leaves the owner's network). Builds on the shipped journey-nudge plugin (`packages/nudge`, spec `2026-10-22-journey-nudge-plugin-design.md`). Nothing in this document has been built.

## 1. Intent

The nudge plugin sends behaviour-triggered messages ("did A, did not reach goal G in time T"). Marketing needs more: send a message to a chosen group at a chosen time, reuse templates, see what happened, test variants. The aim is one plugin, renamed **marketing**, that covers journeys (what exists) and campaigns (new), with enough throughput that the plugin is never the slow part of a send.

The first real campaign, in the owner's words: "send the notification to specific university, specific course, specific semester users". The owner's platform is ed-tech: about 50,000 students, largest single audience about 20,000. The student data (users, universities, enrollments) lives in a self-managed Postgres in AWS Hyderabad, spread over several tables, mostly one course per student and rarely several. The owner's student id equals the profile id the app sends to OpenPanel. Push is Firebase (FCM). Email is today a free Gmail SMTP account.

**Decision of the owner (revision 2):** student data must not be copied to another location. The marketing workers run in AWS Hyderabad next to the database, and student details are served to them through a read-only API service that the owner can build to whatever shape is required.

The module stays generic: any industry can adopt it. "University, course, semester" is the owner's data, not the plugin's vocabulary.

## 2. Goals, non-goals, anti-goals

Goals
- Rename the plugin to **marketing**; journeys become one feature inside it.
- An **audience source** contract: the plugin asks an HTTP API (built by the adopter) which people match a filter and how to reach them, and never stores that personal data.
- Audiences built in the dashboard from the dimensions the API declares, with a live count.
- One-off and scheduled campaigns over email, push and webhook, sent by a high-throughput engine that never delays journey nudges.
- No self-imposed throttle: the only rate limits are the provider's and the audience API's, set by the operator.
- Later: templates and visual editor, delivery/engagement tracking, A/B tests, branching journeys.

Non-goals (this document)
- AI-written messages; SMS and WhatsApp channels; a CRM; a customer-facing preference centre beyond one opt-out; billing; replicating the owner's tables.

Anti-goals (a failure even if it technically works)
- Any edit to an existing OpenPanel file beyond the one sidebar link and generated files already allowed (fork must stay updatable).
- Student emails, names or device tokens persisted in the plugin's database, logs, Redis, templates or send records (ids only).
- The plugin overloading the owner's API or database (it must page, bound its concurrency and back off).
- A campaign delaying a journey nudge, or the reverse.
- Sending twice to one person for one campaign, or sending to someone who opted out.
- Claims of throughput without a measurement in this repository.

## 3. Constraints and what is reused

- Fork discipline from `packages/nudge/AGENTS.md` carries over (new files only; allowed existing-file edits are the sidebar link, `routeTree.gen.ts`, `bun.lock`).
- Stack: TypeScript on Bun, Postgres (plain SQL migrations with the plugin's own runner), Redis, Redpanda via `kafkajs`, dashboard in `apps/start`.
- Reused as is: channel adapters (email, push, webhook; hard send deadlines; invalid-token pruning), the strict template renderer, API-key auth, dashboard proxy and role rule, rate limiter, unsubscribe tokens, `FOR UPDATE SKIP LOCKED` lease pattern, migration runner, load-test harness.

### 3.1 Deployment topology (decided by the owner's answers)

```
Hetzner:  OpenPanel (dashboard, API, Redpanda "events", ClickHouse, its Postgres)
              │ events topic (TLS+SASL, outbound from AWS)        ▲ dashboard proxy (HTTPS + shared secret)
AWS Hyderabad:▼                                                   │
          marketing worker(s) ── marketing Postgres (+ Redis) ── audience API (read-only) ── owner's Postgres
```

- Assumed (owner to confirm): OpenPanel and its Redpanda stay at Hetzner. The worker in AWS consumes the events topic across the WAN over an authenticated, encrypted connection initiated from AWS. Events carry ids and event properties, not student records. The WAN carries the whole topic including events the plugin discards; the bandwidth is measured in phase 1 and, if too high, a filtered mirror topic is added.
- The dashboard at Hetzner reaches the worker through the existing proxy over HTTPS; the worker's HTTP port is exposed in AWS only to the Hetzner addresses (security group allow-list) behind TLS. Unsubscribe links go to the dashboard's pass-through route as today.
- The marketing database lives in AWS next to the workers. By default it is a separate database (`MARKETING_DATABASE_URL`); sharing OpenPanel's database is still supported for small installs but is not the topology above.
- The owner's production database is reached only by the audience API service, never by the plugin.

## 4. Roadmap

| Phase | Scope | Detail in this document |
|---|---|---|
| 1 | Rename to marketing; deployment topology; audience source contract with an HTTP source and a reference service; journeys resolve contacts through the source | Section 5 |
| 2 | Audience builder, campaigns, send engine | Section 6 |
| 3 | Templates and visual email editor | Section 7 (outline) |
| 4 | Delivery and engagement tracking, reports, attribution | Section 7 (outline) |
| 5 | A/B tests, branching journeys | Section 7 (outline) |

Each phase gets its own plan and is reviewed and merged separately. Phase N+1 is not started before phase N is reviewed.

## 5. Phase 1: rename, topology, audience source

### 5.1 Rename

Everything user-visible and operational changes together, in one commit series, while nothing is deployed:

| Now | After |
|---|---|
| package `@openpanel/nudge`, dir `packages/nudge` | `@openpanel/marketing`, `packages/marketing` |
| Postgres schema `nudge` | `marketing` |
| env `NUDGE_*` | `MARKETING_*` (old names not kept: no installs exist) |
| HTTP `/nudge/*`, dashboard proxy `/nudge-api/*`, route `/nudge` | `/marketing/*`, `/marketing-api/*`, `/marketing` |
| Redis keys `nudge:*`, consumer group `nudge`, compose service `op-nudge`, files `docker-compose.nudge.yml`, `.github/workflows/nudge.yml` | `marketing:*`, `marketing`, `op-marketing`, `docker-compose.marketing.yml`, `.github/workflows/marketing.yml` |
| sidebar label "Nudges" | "Marketing", with tabs Journeys (the existing rules), Campaigns, Audiences, Channels, Results, How it works |
| components `apps/start/src/components/nudge/` | `.../marketing/` |

Done with git renames so history follows. The existing migrations are edited in place to create schema `marketing` because nothing is deployed; if any database does exist at that point (including the owner's staging), the builder stops and asks before choosing a rename migration. Tests, docs (README, GUIDE, spec) and the in-app guide are updated in the same series. The old spec and plan stay as history.

### 5.2 Audience source: the contract

The plugin defines one internal interface, **AudienceSource**, with two implementations:
- `http` (the owner's choice): calls the adopter's read-only API described below.
- `stored` (kept for adopters who cannot build an API): the existing contacts/devices tables fed by the current sync endpoints. It is the small fallback and not extended in this roadmap.

A project selects its source in settings. The contract the `http` source calls (JSON over HTTPS; the plugin is always the client):

| Call | Purpose |
|---|---|
| `GET /schema` | Declares the filterable **dimensions**: `key`, `label`, `type` (string, number, date, boolean), `multiValued`, `valuesListable`. The dashboard builds the audience builder from this, so the plugin has no university or course vocabulary. |
| `GET /dimensions/{key}/values?q=&limit=` | Values for dropdowns and search (only if `valuesListable`). |
| `POST /audience/count` | Body: filter tree. Returns `{count, approximate?}` for the live count. |
| `POST /audience/members` | Body: filter tree, `cursor`, `limit` (at most 1,000), `fields` (`id` only, or `contact`). Returns members and `nextCursor`. Keyset pagination on a stable id order; a member who changes during a long read may or may not be included (acceptable). |
| `POST /members/lookup` | Body: up to 500 ids and the channel wanted. Returns for each: `email?`, `devices?[{token, platform}]`, `traits{}` (the values templates use, for example `firstName`), `suppressed?` (true for a person who must not be messaged, for example a withdrawn student). Missing ids are returned as not found. |

- **Filter tree**: the plugin's own JSON (groups joined by AND/OR, depth limit 3; conditions `{dimension, op, values}` with ops eq, in, not_in, gt, lt, between, exists). The plugin only sends dimensions the API declared. The API turns it into parameterised SQL; the contract states that string-built SQL from the filter is forbidden. A conformance test suite ships with the plugin so an adopter can verify their API (including hostile inputs).
- **Auth and network**: a bearer secret plus HMAC of the body and timestamp (replay window), TLS, and the API's own IP allow-list. The API never calls the plugin. The secret is stored encrypted like channel secrets and masked in the dashboard.
- **Personal data handling**: contact fields exist only in memory for the duration of one batch and are not logged (the existing redaction applies to API responses). Not stored: email, name, tokens, rendered bodies. Stored: the stable id, status and reason per send, timestamps. Suppression and opt-out records are keyed by id. Unsubscribe tokens carry ids only. Redis never holds contact data.
- **Resilience**: per-call timeouts (defaults 10 s, count 5 s), at most `MARKETING_SOURCE_CONCURRENCY` calls in flight (default 4), retry on 5xx and 429 with jittered exponential backoff honouring `Retry-After`, and a circuit breaker. If the API is down, campaigns pause and resume on their own and journey steps stay pending; nothing is marked failed because the source was unreachable.
- **Recommended API service levels** (stated in the contract, checked by the conformance suite as warnings): `count` under 2 s, a page of 1,000 members under 2 s, a lookup of 500 under 1 s, at the owner's scale.

### 5.3 Journeys through the source

Journeys no longer read stored contact rows when the `http` source is selected: when a step is due, the engine batches the due steps (up to 500 per lookup), calls `/members/lookup`, personalises and sends. A person returned as not found or suppressed has the step recorded as skipped with that reason. The existing sync endpoints and tables remain only for the `stored` source.

### 5.4 Reference audience API

An optional, separate, runnable example service (`packages/marketing/examples/audience-api-postgres`, new files, not part of the worker image) implements the contract over a Postgres schema through a small mapping file: dimensions mapped to columns or joins, the id column, the contact columns. It shows parameterised filter compilation and passes the conformance suite. The owner may use it as a base for the read-only API service in AWS or write their own.

### 5.5 Database option

`MARKETING_DATABASE_URL` (falls back to `DATABASE_URL`). The runner, pool sizing and health code read the same setting. Tests run against both a shared and a dedicated database.

### 5.6 What this phase leaves out

No data replication of any kind; no connector; no traits or memberships tables; no automatic audience API (the reference service is an example); the dashboard does not edit the API's dimension mapping (that is the API's responsibility).

## 6. Phase 2: audiences, campaigns, send engine

### 6.1 Audiences

- A saved audience is a filter tree built in the dashboard from the dimensions in `/schema`, with value dropdowns from `/dimensions/{key}/values`.
- **Live count** via `/audience/count`, shown with a timestamp. If the API is slow or down the builder says so and the count is not blocking for saving.
- **Frozen at send**: starting a campaign materialises the matching **ids** (never contact details) into the campaign's recipient list by paging `/audience/members` with `fields=id`; later data changes do not alter a running campaign.
- Optional per-audience exclusion of ids with a recent send of the same campaign key, to avoid repeats.

### 6.2 Campaigns

- States: draft, scheduled, running, paused, completed, cancelled, failed.
- A campaign has: an audience, one channel (a multi-channel send is several campaigns, my call), a template (same variables as journeys, `{{profile.<trait>}}` from the lookup's `traits`), a send time (now or a schedule with timezone), optional quiet hours, and an optional per-person frequency cap shared with journeys.
- Safety gates: a test send to the creator's own address or device; a mandatory count preview; confirmation naming count and channel for audiences over a configurable size (default 5,000); only owners and admins can start or schedule (existing role rule), members can draft and preview.
- People who are opted out, suppressed, have no address/device for the channel, or are capped are **recorded as skipped with a reason**, never silently dropped.
- Cancel and pause take effect within one dispatch cycle; resume continues where it stopped.
- **Email quota**: the email channel has a required daily quota and a per-second ceiling (no unlimited default for email). A campaign larger than the remaining daily quota warns before starting and offers to spread the send over several days (recipients stay pending and resume the next day). The operator guide recommends a transactional provider (Amazon SES in Mumbai, Brevo, Mailgun, SendGrid) with SPF, DKIM and DMARC on the sending domain, because free Gmail SMTP (about 500 messages a day, no bulk allowance) cannot carry a 20,000-person campaign. No code change is needed for that, only channel settings.

### 6.3 Send engine

- **Materialise ids once**, in chunks, into `campaign_recipients(campaign_id, profile_id, status, attempt, due_at, ...)`.
- **Dispatch in batches**: claim a batch of recipients with `FOR UPDATE SKIP LOCKED` and a lease, call `/members/lookup` for up to 500 ids, render each message, hand them to the channel adapter, and write a fenced "sent" mark per recipient with a stable idempotency key per campaign and person. Contact details exist only in that batch's memory. A crashed worker's leased rows return to the pool and are never sent twice because the durable mark is fenced.
- **Separate lane**: campaign dispatch has its own claim query, worker pool and concurrency budget; journeys keep theirs. Both share the adapters and the same source-concurrency cap, with journeys given priority on that cap so a campaign cannot starve them.
- **Throughput comes from concurrency, not a throttle.** Per channel: `concurrency` and an optional `ratePerSecond` ceiling set to the provider's quota (required for email, optional for push and webhook). The engine adds no delays of its own. A 429 from a provider backs off that channel only and the recipient stays pending.
- **Email**: pooled, reused SMTP connections per replica with pipelining. **Push**: FCM multicast in batches of 500 tokens. **Webhook**: one signed POST per recipient.
- **Scale out**: more replicas claim different batches; no coordination beyond row leases. One running campaign per project by default; extras queue.
- **Progress**: counters (queued, sent, failed, skipped) updated in batches and shown live.

### 6.4 Targets (to be measured, not assumed)

| Measure | Target | How it is verified |
|---|---|---|
| Plugin overhead per send with a no-op channel and an instant fake API | at least 1,000 sends/s per replica | load script |
| Materialise 20,000 ids from a fake API serving 1,000 per page | plugin time under 5 s on top of the API's own time | load script |
| Journey step latency during a 20,000-person campaign | no worse than 2x the idle median | load script runs both lanes together |
| Plugin behaviour against a slow API (2 s per page) | no timeouts, no duplicates, campaign finishes | load script with a delaying fake API |
| Plugin behaviour when the API fails for 60 s | campaign pauses and resumes, no failed marks, no duplicates | integration test |
| Events consumed across a WAN-like delay (200 ms) | consumer keeps up with the owner's event rate | measured with an injected delay |
| End-to-end for the owner's scale: 20,000 pushes | finishes within 10 minutes of start, provider speed permitting | load run with a fake FCM at a realistic rate |

If a target cannot be met the document is updated with the measured value and the reason, instead of quoting the target as achieved. Real provider and real API speeds are the owner's to measure on their setup.

## 7. Phases 3 to 5 (outline only)

- **Phase 3, templates and editor**: reusable named templates with versions; a block-based visual email editor producing safe HTML through the same strict renderer; image limits; automatic plain-text alternative; test sends.
- **Phase 4, tracking and reports**: delivery events from the channels (SMTP accept, provider webhooks for bounce and complaint), open pixel and link redirects through the plugin's own domain with signed tokens, per-campaign and per-journey reports, suppression of hard bounces and complaints, revenue attribution by matching a purchase event within a window of the send. High-volume engagement storage moves to ClickHouse behind a small write interface at this phase; this stays ids and counters only.
- **Phase 5, A/B and branching**: split an audience into variants (subject, content, send time) with a winner chosen on a metric after a sample window; journey steps that branch on a condition (opened, clicked) instead of only waiting.

## 8. Verification (concrete)

Each phase ends only when these have been run and their outputs recorded:

- Package test suite and typecheck, dashboard vitest, `ultracite` on touched files, root `bun run typecheck`.
- Phase 1: no `nudge` identifier remains except in historical docs (a grep test); the fork-discipline diff check (only new files plus the allowed three) passes; the conformance suite passes against the reference service; a test proving no contact field (email, token, name) appears in the database, Redis or logs after journeys and campaigns run; journeys deliver through the `http` source in an end-to-end run with a real reference service backed by a seeded Postgres.
- Phase 2: filter validation and hostile-input tests; no recipient sent twice under crashed workers, cancelled campaigns and concurrent replicas; the lane-isolation and slow/failing-API tests from section 6.4; opted-out, suppressed and capped people skipped with reasons.
- A full pass of the dashboard flows in a real browser with an owner, a member and a no-access user (not run for the journey plugin; required now).

## 9. Calls made by the author (not yet agreed by the owner)

1. Rename is total and immediate, with no backward-compatible `NUDGE_*` names.
2. The `stored` source stays as a small fallback; the `http` source is the owner's path.
3. A dedicated Postgres database is the default topology, in AWS next to the workers.
4. ClickHouse is deferred to phase 4 and holds ids and counters only.
5. One channel per campaign.
6. Email has a required daily quota and rate ceiling; push and webhook default to none.
7. One running campaign per project by default; journeys get priority on the audience-API concurrency cap.
8. Marketing and journey messages share one opt-out for now. An opt-out comes only from the unsubscribe link, the dashboard and the API, never from the source; a source can mark a person `suppressed`.
9. A person deleted at the owner's side simply stops appearing in the source (or is `suppressed`); the plugin keeps only the id and opt-out record.
10. Quiet hours defer: a recipient inside the window stays pending and is released at the window end, in the campaign's timezone.
11. The frequency cap is N messages per person per rolling window across journeys and campaigns, from one ledger table written when a send is marked and checked at claim time (an indexed count, not a shared lock).
12. Audience contract details (the five calls, filter shape, auth by bearer plus HMAC) and the service-level numbers are my proposal.
13. Hetzner remains the home of OpenPanel and its Redpanda, and the worker consumes events across the WAN (to be measured; mirror topic if needed).
14. Nothing is deployed, including staging, at rename time; the builder confirms and stops if not.
15. The builder creates the owner/member/no-access fixtures for the browser pass.

## 10. Left to the builder

Table and index definitions, column types, the filter tree's exact JSON schema, topic and group naming, the reference service's mapping file format, dashboard layout of the new tabs, error wording, and how to split each phase into tasks.
