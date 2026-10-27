# Marketing platform on OpenPanel: roadmap and design

Status: draft for approval. Builds on the shipped journey-nudge plugin (`packages/nudge`, spec `2026-10-22-journey-nudge-plugin-design.md`). Nothing in this document has been built.

## 1. Intent

The nudge plugin sends behaviour-triggered messages ("did A, did not reach goal G in time T"). Marketing needs more: send a message to a chosen group at a chosen time, reuse templates, see what happened, test variants. The aim is one plugin, renamed **marketing**, that covers journeys (what exists) and campaigns (new), with enough throughput that the plugin is never the slow part of a send.

The first real campaign, in the owner's words: "send the notification to specific university, specific course, specific semester users". The owner's platform is ed-tech: about 50,000 students, largest single audience about 20,000, user data in Postgres spread over several tables (users, universities, enrollments/semesters), mostly one course per student, rarely several.

The module stays generic: any industry can adopt it. "University, course, semester" is the owner's data, not the plugin's vocabulary.

## 2. Goals, non-goals, anti-goals

Goals
- Rename the plugin to **marketing**; journeys become one feature inside it.
- Keep contact data in sync with the owner's Postgres in near real time, with the sync work done by the plugin, not by the owner's application.
- Audiences built from traits and memberships with a live count.
- One-off and scheduled campaigns over email, push and webhook, sent by a high-throughput engine that never delays journey nudges.
- No self-imposed throttle: the only rate limits are the provider's, set by the operator.
- Later: templates and visual editor, delivery/engagement tracking, A/B tests, branching journeys.

Non-goals (this document)
- AI-written messages; SMS and WhatsApp channels; a CRM; a customer-facing preference centre beyond one opt-out; multi-tenant billing.

Anti-goals (a failure even if it technically works)
- Any edit to an existing OpenPanel file beyond the one sidebar link and generated files already allowed (fork must stay updatable).
- The sync adding load to the owner's application database beyond a replication slot or a read replica.
- A campaign delaying a journey nudge, or the reverse.
- Sending twice to one person for one campaign, or sending to someone who opted out.
- Claims of throughput without a measurement in this repository.

## 3. Constraints and what is reused

- Fork discipline from `packages/nudge/AGENTS.md` carries over unchanged (new files only; allowed existing-file edits are the sidebar link, `routeTree.gen.ts`, `bun.lock`).
- Stack: TypeScript on Bun, Postgres (plain SQL migrations with the plugin's own runner), Redis, Redpanda via `kafkajs`, dashboard in `apps/start`.
- Reused as is: the channel adapters (email, push, webhook, with their hard send deadlines and invalid-token pruning), the template renderer (strict, fails closed), API-key auth, dashboard proxy and role rule, rate limiter, unsubscribe tokens, `FOR UPDATE SKIP LOCKED` lease pattern, migration runner, load-test harness.
- Environment: self-hosted Docker Compose. The owner's user database is Postgres.

## 4. Roadmap

| Phase | Scope | Detail in this document |
|---|---|---|
| 1 | Rename to marketing; data foundation (database option, sync from the owner's Postgres, traits and memberships) | Section 5 |
| 2 | Audiences, campaigns, send engine | Section 6 |
| 3 | Templates and visual email editor | Section 7 (outline) |
| 4 | Delivery and engagement tracking, reports, attribution | Section 7 (outline) |
| 5 | A/B tests, branching journeys | Section 7 (outline) |

Each phase gets its own plan and is reviewed and merged separately. Phase N+1 is not started before phase N is reviewed.

## 5. Phase 1: rename and data foundation

### 5.1 Rename

Everything user-visible and operational changes together, in one commit series, while nothing is deployed:

| Now | After |
|---|---|
| package `@openpanel/nudge`, dir `packages/nudge` | `@openpanel/marketing`, `packages/marketing` |
| Postgres schema `nudge` | `marketing` |
| env `NUDGE_*` | `MARKETING_*` (the old names are not kept: no installs exist) |
| HTTP `/nudge/*`, dashboard proxy `/nudge-api/*`, route `/nudge` | `/marketing/*`, `/marketing-api/*`, `/marketing` |
| Redis keys `nudge:*`, consumer group `nudge`, compose service `op-nudge`, files `docker-compose.nudge.yml`, `.github/workflows/nudge.yml` | `marketing:*`, `marketing`, `op-marketing`, `docker-compose.marketing.yml`, `.github/workflows/marketing.yml` |
| sidebar label "Nudges" | "Marketing", containing tabs Journeys (the existing rules), Campaigns, Audiences, Channels, Results, How it works |
| components `apps/start/src/components/nudge/` | `.../marketing/` |

Done with git renames so history follows. Migrations keep their numbers; migration 0007 renames nothing in a live database because no database exists yet, so the existing migrations are edited in place to create schema `marketing`. If any database does exist at that point, the builder stops and asks before choosing a rename migration. All tests, docs (README, GUIDE, spec) and the in-app guide are updated in the same series. The old spec and plan files stay as history.

### 5.2 Separate database option

`MARKETING_DATABASE_URL` (falls back to `DATABASE_URL`, so small installs still share OpenPanel's database). Recommended for the owner: a dedicated Postgres database so contact volume and campaign logs cannot compete with OpenPanel's own configuration data. The migration runner, pool sizing and lag/health code read the same setting. Tests run against both a shared and a dedicated database.

### 5.3 Data model: traits and memberships

- `contacts(project_id, profile_id, email, version, updated_at, opted_out_at, ...)`: one row per person.
- `contact_traits(project_id, profile_id, key, value, version)`: one value per key per person (university, name, plan). Values are text with an optional declared type (text, number, date) per project in `trait_definitions` so filters can compare numerically.
- `contact_memberships(project_id, profile_id, kind, value, attrs jsonb, valid_from, valid_to, version)`: many per person (for the owner: kind `course`, value the course id, attrs `{semester: 3, university: ...}`). A membership with `valid_to` in the past no longer matches.
- Indexes: `(project_id, key, value)` on traits, `(project_id, kind, value)` and a GIN on `attrs` for memberships, `(project_id, profile_id)` everywhere. These serve audience queries without a table scan (verified in section 8).
- Existing `contacts.attributes` (jsonb, used by `{{profile.*}}`) is migrated into traits; templates keep working through a compatibility read.

### 5.4 Sync from the owner's Postgres

Chosen path (my recommendation, to be approved): change capture into Redpanda, processed by the plugin.

```
owner Postgres ──logical replication──▶ connector (Debezium or Redpanda Connect) ──▶ topics ──▶ marketing consumer ──▶ contacts/traits/memberships
```

- The connector runs as an optional compose service (`docker-compose.marketing-sync.yml`, new file), reading a publication on the owner's tables. The owner's application is unchanged; the owner's database carries one replication slot. A read replica can host it.
- Each source table streams to its own topic. A **mapping file** (JSON, kept in the project's settings and editable in the dashboard) tells the plugin what a topic means: which table, which column is the person id, which columns become traits, which table rows become memberships, optional filters. The plugin does the joining: it never needs a joined row from the owner.
- Message formats accepted: the Debezium envelope (`before`, `after`, `op`, `ts_ms`) and a plain format `{op, key, data, ts}` for owners without a connector. The REST endpoints (`PUT /marketing/contacts/:id`, bulk `POST /marketing/contacts/batch` of up to 1,000 per call as NDJSON) are kept and write to the same topic, so there is one processing path.
- Processing: a dedicated consumer group (`marketing-sync`) separate from the event consumer. Messages are keyed by person id so one person's changes stay ordered. Writes are batched (target: multi-row `INSERT ... ON CONFLICT` of 1,000+ rows per statement) and guarded by `version`/source timestamp: a message older than the stored one is dropped. Deletes of a person set a tombstone; opt-outs are never undone by a sync message.
- A person arriving from a child table before their user row (ordering across topics) is stored with the data present; the contact becomes sendable once an email trait exists.
- First load: the connector's snapshot fills the topics; the plugin reports progress (rows processed, lag per topic) on a Sync status panel in the dashboard.
- Lag is exposed (per topic, seconds behind) and shown in the dashboard. A campaign preview warns when the sync is more than N seconds behind (default 60).
- The sync consumer's load is isolated: its own consumer group, its own connection budget, and it cannot starve the send engine (sending reads only already-written rows).

### 5.4a Owner's topology (decided by the owner's answers)

Facts from the owner: the production Postgres is self-managed on AWS (Hyderabad); only some tables are needed; the marketing database and the plugin run on Hetzner, a different location and network.

Consequences, as the design:
- **Selective replication.** The source publication lists only the needed tables and, on Postgres 15 or newer, only the needed columns (`CREATE PUBLICATION ... FOR TABLE users (id, email, first_name, ...)`), with row filters where useful (for example active students only). Nothing else leaves the production network, which also limits personal data transferred. On Postgres 14 or older the connector's own column include list does the same.
- **Connector placement: next to the source.** The connector runs in the same AWS network as the production database and reads it locally, then publishes to the Redpanda at Hetzner over an authenticated, TLS-encrypted connection (SASL plus TLS; a site-to-site VPN or WireGuard tunnel is acceptable instead). The production database is never exposed to the internet and never accepts connections from Hetzner. My call.
- **WAN failures are expected.** The link between Hyderabad and Hetzner will sometimes be slow or down. The connector buffers and retries. The danger is the replication slot: while the connector cannot advance, production keeps WAL on disk. So the operator guide requires `max_slot_wal_keep_size` on the source (Postgres 13+) to cap that disk use (an over-limit slot is invalidated and the sync re-snapshots instead of filling the production disk), plus an alert on slot lag. The plugin's Sync status panel shows the end-to-end lag per topic but cannot see the source slot; the operator alert is therefore an operations requirement, not plugin code.
- **Latency is irrelevant to correctness.** The sync is asynchronous and idempotent; a round trip of a couple of hundred milliseconds between the two sites only adds to the end-to-end delay. The "under 5 s at idle" target stays; it is measured with the connector and the Redpanda on the real two-site setup or an equivalent simulated delay.
- **Initial snapshot over the WAN** is done once, in chunks, with the connector's snapshot throttled so production is not loaded; the operator guide says to run it at a quiet time or from a read replica.
- **Personal data crossing a border.** Student names and emails would move from India to a Hetzner region. The operator should check that against the data-protection rules that apply to them (for example India's DPDP Act). The plugin supports minimising what is sent (selected columns) but does not provide legal advice.
- Assumed (owner to confirm): OpenPanel's Redpanda and the marketing plugin both run at Hetzner, so the sync topics live in the Redpanda the plugin already uses.

### 5.5 What this phase leaves out

No UI to create connectors (the compose file and the mapping are configured by the operator); no sync from MySQL, SQL Server or Mongo (the plain topic format is the extension point).

## 6. Phase 2: audiences, campaigns, send engine

### 6.1 Audiences

- A saved audience is a filter tree: groups of conditions joined by AND/OR, depth limited (default 3), each condition one of: trait equals/in/not in/contains/greater/less/exists; membership of kind K with value in V and optional attribute conditions (for example `semester = 3`); has channel (email, device); opted in.
- The tree is validated with a strict schema and compiled to **parameterised SQL** (never string-built from user input; keys and kinds are checked against the project's known keys). Compilation happens in one place and is covered by tests including hostile input.
- **Live count** while editing: `SELECT count(*)` over the compiled filter, with a statement timeout, shown with "as of the last sync N seconds ago". For the owner's data (50,000 contacts) this is a single indexed query; the target is under 500 ms for 50,000 contacts and under 3 s for 5,000,000 (verified).
- **Dynamic by default, frozen at send**: an audience is re-evaluated each time it is used; a campaign freezes the matching people into its recipient list at the moment it starts (section 6.3), so later data changes do not alter a running campaign.
- The dashboard builder offers dropdowns populated from known trait keys and values (distinct values come from the data, with a cap and search for high-cardinality keys).

### 6.2 Campaigns

- States: draft, scheduled, running, paused, completed, cancelled, failed.
- A campaign has: an audience, one channel per campaign (email, push or webhook; a multi-channel campaign is several campaigns, my call to keep the model simple), a template (subject/body with the same variables as journeys plus `{{trait.<key>}}` aliases for `{{profile.<key>}}`), a send time (now or a schedule with timezone), optional quiet hours, and an optional per-person frequency cap shared with journeys.
- Safety gates before a campaign can start: a test send to the creator's own address or device; a mandatory preview of the audience count; for audiences over a configurable size (default 5,000) a second confirmation naming the count and channel. Only owners and admins can start or schedule (existing role rule); members can draft and preview.
- Recipients who are opted out, have no address/device for the channel, or are capped are **recorded as skipped with a reason**, never silently dropped.
- Cancel and pause take effect within one dispatch cycle; resume continues from where it stopped.

### 6.3 Send engine

Design requirements, then the mechanism.

- **Materialise once.** When a campaign starts, one statement inserts its recipients into `campaign_recipients(campaign_id, profile_id, status, attempt, due_at, ...)` from the compiled audience query (`INSERT ... SELECT`), in chunks so a 1,000,000-person audience does not hold one long transaction. Target: 20,000 recipients materialised in under 5 s.
- **Separate lane.** Campaign sends use their own claim query and worker pool, with their own concurrency budget, so a 20,000-person campaign cannot delay journey steps and journey bursts cannot delay a campaign. Both lanes share the channel adapters.
- **Claim in batches** with `FOR UPDATE SKIP LOCKED`, leases and fenced completion marks, exactly the pattern already proven for journey steps (a crashed worker's leased rows return to the pool; a recipient is never sent twice because the durable "sent" mark is written fenced and the idempotency key is stable per campaign and person).
- **Throughput comes from concurrency, not a throttle.** Operator settings per channel: `concurrency` (parallel sends) and an optional `ratePerSecond` ceiling that matches the provider's quota. Default for the ceiling is **none**. The engine never adds delays of its own. If a provider answers 429/rate-limited, the engine backs off that channel only, with a jittered exponential delay, and the recipient stays pending (not failed).
- **Email**: pooled, reused SMTP connections per replica (nodemailer pool) with pipelining; per-recipient personalised bodies. **Push**: Firebase multicast in batches of 500 tokens. **Webhook**: one signed POST per recipient (or per batch of up to 100 if the receiver opts into batch mode, my call for a later increment).
- **Scale out**: more replicas claim different batches; no coordination beyond row leases.
- **Backpressure and fairness**: one running campaign per project by default, extra ones queue (configurable); a global concurrency cap protects the database connection pool (`MARKETING_DB_POOL`).
- **Progress**: counters (queued, sent, failed, skipped) update in batches, not per row, and are shown live in the dashboard.

### 6.4 Targets (to be measured, not assumed)

| Measure | Target | How it is verified |
|---|---|---|
| Audience count, 50,000 contacts | under 500 ms | load script, `EXPLAIN` shows index use |
| Audience count, 5,000,000 contacts | under 3 s | same, on generated data |
| Materialise 20,000 recipients | under 5 s | load script |
| Engine dispatch overhead, with a no-op channel adapter | at least 1,000 sends/s per replica | load script (provider speed excluded) |
| Journey step latency during a 20,000-person campaign | no worse than 2x idle median | load script runs both lanes together |
| Sync apply rate | at least 5,000 row changes/s per replica | load script feeding the sync topic |
| Sync end-to-end delay at idle | under 5 s from owner commit to queryable | integration test with a real replication stream |

Numbers are targets; if one cannot be met the spec is updated with the measured value and the reason rather than the target being quoted as achieved.

## 7. Phases 3 to 5 (outline only)

- **Phase 3, templates and editor**: reusable named templates with versions; a block-based visual email editor producing safe HTML (output passes through the same strict renderer; no script, forms or remote-resource tricks); image upload limits; plain-text alternative generated automatically; test sends.
- **Phase 4, tracking and reports**: delivery events from the channels (SMTP accept, provider webhooks for bounce/complaint), open pixel and link redirects through the plugin's own domain with signed tokens, per-campaign and per-journey reports, suppression of hard bounces and complaints, revenue attribution by matching a purchase event within a window of the send. High-volume event storage moves to ClickHouse behind a small write interface at this phase.
- **Phase 5, A/B and branching**: split a campaign audience into variants (subject, content, send time) with a winner chosen on a metric after a sample window; journey steps that branch on a condition (opened, clicked, trait value) instead of only waiting.

## 8. Verification (concrete)

Each phase ends only when these have been run and their outputs recorded:

- Package test suite and typecheck, dashboard vitest, `ultracite` on touched files, root `bun run typecheck`.
- Phase 1: rename leaves no `nudge` identifier except in historical docs (a grep test fails the build otherwise); the fork-discipline diff check (only new files plus the allowed three) passes; sync tests for ordering, duplicates, late messages, deletes, tombstones, opt-out preservation, topic-before-user ordering; an integration run with a real Postgres logical replication slot and connector against a seeded users/universities/enrollments schema, measuring end-to-end delay.
- Phase 2: audience compiler tests including injection attempts and depth limits; a send test proving no recipient is sent twice under crashed workers, cancelled campaigns and concurrent replicas; the lane-isolation load test from section 6.4; a test that opted-out and capped people are skipped with reasons.
- A full pass of the dashboard flows in a real browser with an owner, a member and a no-access user (the checks that were not run for the journey plugin and are now required).

## 9. Calls made by the author (not yet agreed by the owner)

1. Rename is total and immediate, with no backward-compatible `NUDGE_*` names.
2. Change capture through Redpanda for sync, with the plugin owning the joins; REST kept as a second door onto the same topic.
3. A dedicated Postgres database is recommended; sharing OpenPanel's database stays supported.
4. Traits plus memberships as the data model; ClickHouse deferred to phase 4 for engagement events only.
5. One channel per campaign.
6. A default of no rate ceiling, with an operator-set ceiling per channel.
7. One running campaign per project by default.
8. Marketing and journey messages share one opt-out for now.
9. Targets in section 6.4 are my estimates for what is achievable and worth guaranteeing; they are to be measured.
10. Mapping rows to memberships: each source row is identified by its table primary key, so an update or delete of that row updates or ends exactly one membership. Traits that live on a parent table (university name from a university id) are resolved by the plugin: it keeps a small cache of the reference table from its own topic and re-derives the traits of the affected people when a reference row changes. The owner never has to flatten rows.
11. Version guard is per source row, not per topic: Debezium rows use the source log position (LSN) and `ts_ms`; plain-format rows use their `ts`; REST writes use server time. The highest version for a row wins, and ties keep the existing value. When the REST door and the connector write the same person, the higher version wins.
12. Opt-out comes from the unsubscribe link, the dashboard and the API only. A sync message can never set or clear it. A person deleted at the source is tombstoned (never sent to), and their traits and memberships are purged after a configurable retention (default 30 days); the contact id and opt-out record are kept so they are never re-added and messaged by a later sync.
13. Quiet hours defer: a recipient inside the window stays pending and is released at the window end, measured in the campaign's timezone (not the recipient's).
14. Frequency cap is N messages per person per rolling window across journeys and campaigns, counted from a single ledger table written when a send is marked, and checked at claim time. The ledger is read by both lanes but never locks them against each other (a cap check is an indexed count, not a shared lock).
15. The 5,000,000-contact audience target is aspirational; the commitment is the owner's scale (50,000 contacts, 20,000-person campaigns) with headroom of 10x. Materialised or partitioned structures are not built unless measurement shows the 10x headroom is missed.
16. Nothing is deployed, including staging, at rename time (the builder confirms with `git` and the compose files and stops and asks if not).
17. The sync status panel includes replication-slot lag and warns when it grows, because an unconsumed slot fills the source disk.
18. The builder creates the owner/member/no-access fixtures for the browser pass.
19. Owner facts: a student's id in the user table equals the profile id the app sends to OpenPanel, so synced data and journeys describe the same person with no identity mapping. Push is Firebase (FCM) only. Email is today a free Gmail SMTP account.
20. Free Gmail SMTP (about 500 messages a day, no bulk-mail allowance) cannot carry a 20,000-person campaign and risks account suspension. The email channel therefore gets required settings: a daily quota and a per-second ceiling, with no default of unlimited for email. A campaign larger than the remaining daily quota warns before starting and offers to spread the send over several days (recipients stay pending and resume the next day), never failing partway. The operator guide recommends a transactional provider (Amazon SES in Mumbai, Brevo, Mailgun, SendGrid) with the sending domain's SPF, DKIM and DMARC records; the plugin needs no code change for that because it already speaks SMTP. Gmail and Yahoo bulk-sender rules also require one-click unsubscribe, which the plugin already provides.
21. Opt-out source unanswered by the owner; the call in item 12 stands (link, dashboard and API only).

## 10. Left to the builder

Exact table and index definitions, column types, the filter tree's JSON shape, topic and group naming, connector configuration files, dashboard layout of the new tabs, error message wording, and how to split each phase into tasks.
