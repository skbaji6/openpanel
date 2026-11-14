# @openpanel/marketing

Journey messages for OpenPanel: a separate worker that consumes the events Kafka topic and sends email, push and webhook journey messages. It also keeps audiences and campaigns: an audience selects people from an `http` audience source, and a campaign materialises that audience into a recipient list and a send engine delivers it over push, email, webhook, SMS or WhatsApp (see "Audiences and campaigns" and the guide, section 10). Its tables live in the Postgres schema `marketing`.

New here? Start with the [setup and integration guide](docs/GUIDE.md). This README is the reference.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required unless `MARKETING_DATABASE_URL` is set | Postgres; `connection_limit` is set from `MARKETING_DB_POOL` |
| `MARKETING_DATABASE_URL` | unset | A dedicated database for the plugin; `DATABASE_URL` is used when unset (see "Audience source and topology") |
| `REDIS_URL` | required | Redis |
| `ENCRYPTION_KEY` | required | Encrypts channel config; unsubscribe token key is derived from it |
| `MARKETING_PROXY_SECRET` | required | Shared secret with the dashboard proxy |
| `MARKETING_PUBLIC_URL` | required | Base URL for unsubscribe links and tracking. The production domain is undecided and is supplied by the owner |
| `MARKETING_PORT` | 4100 | HTTP port |
| `MARKETING_TRUST_PROXY` | false | Take the client IP from `x-forwarded-for` (see below) |
| `MARKETING_GRACE_SECONDS` | 300 | Window in which an observed goal cancels a pending journey message |
| `MARKETING_MAX_LAG` | 1000 | Consumer lag above which the ticker pauses sending (nothing is dropped) |
| `MARKETING_TICK_MS` | 5000 | Ticker interval; also how often each replica runs the campaign scheduler and the campaign materialiser |
| `MARKETING_LEASE_SECONDS` | 120 | Lease on claimed steps; must be greater than `MARKETING_LOOKUP_WINDOW_MS` / 1000 + 31 (30 s send timeout plus mark retries), so more than 33 with the default window |
| `MARKETING_EVENT_RETENTION_DAYS` | 30 | Event retention |
| `MARKETING_CLAIM_BATCH` | 200 | Steps claimed per tick |
| `MARKETING_SEND_CONCURRENCY` | 10 | Concurrent sends |
| `MARKETING_CAMPAIGN_CONCURRENCY` | 2 | Campaign send loops per replica (1 to 32); each holds a database connection while it dispatches a batch |
| `MARKETING_DB_POOL` | 15 | Prisma pool size per replica, against the marketing database (`MARKETING_DATABASE_URL`, the intended topology; it falls back to core's `DATABASE_URL`, and then counts against core's `max_connections`); must be at least `MARKETING_SEND_CONCURRENCY` + `MARKETING_CAMPAIGN_CONCURRENCY` + 3 |
| `MARKETING_SOURCE_CONCURRENCY` | 4 | Audience API calls in flight per project, across all replicas (Redis semaphore). Campaign materialisation may use at most this minus one, so journeys always keep a slot; set it to at least 2 (see "Lane priority") |
| `MARKETING_CONFIRM_THRESHOLD` | 5000 | A campaign whose count preview is above this needs an explicit confirmation naming the count and channel. Copied onto each campaign when it is created, so a change applies to new campaigns only |
| `MARKETING_LOOKUP_WINDOW_MS` | 2000 | How long the engine waits to fill a lookup batch (up to 500 ids) before calling `/members/lookup` |
| `MARKETING_MAX_LATENESS` | 86400 | Seconds. A step more than this past its scheduled time is skipped as `expired`, not sent, for both sources. Retries and audience-source deferrals do not reset the clock; quiet hours and the inactivity debounce move the scheduled time |
| `MARKETING_WEBHOOK_ALLOW_HOSTS` | empty | Comma list of internal hosts webhooks may reach |
| `MARKETING_KAFKA_GROUP` | marketing | Consumer group id |
| `KAFKA_BROKERS` | required | Comma list |
| `KAFKA_EVENTS_TOPIC` | required | Topic carrying ingested events |
| `KAFKA_CLIENT_ID` | openpanel-marketing | Client id |
| `KAFKA_SSL`, `KAFKA_SSL_CA_PATH`, `KAFKA_SSL_REJECT_UNAUTHORIZED` | unset | TLS; on by default when SASL is set |
| `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_SASL_MECHANISM` | unset, `scram-sha-512` | SASL needs both username and password |

A blank value counts as unset.

### Client IP and `MARKETING_TRUST_PROXY`

Failed API-key attempts and invalid unsubscribe tokens are limited to 30 per minute per client IP (valid keys and valid unsubscribe links are never limited). With `MARKETING_TRUST_PROXY=false` the client IP is the socket's peer address: behind a reverse proxy every caller shares the proxy's address and therefore one limit. Set it to `true` only when `MARKETING_PORT` is reachable solely through exactly one trusted proxy that appends the client address to `x-forwarded-for`; the worker then uses the rightmost entry. Anything that can reach the port directly could otherwise choose its own IP.

### Dashboard variables

The dashboard serves two marketing paths, both outside `/api` because the stock Caddy and Coolify setups send every `/api*` request to op-api:

- `/marketing-api/*`: the authenticated proxy the marketing pages call.
- `/marketing/unsubscribe` (GET and POST): a public pass-through to the worker's unsubscribe page, so email links work on the dashboard's own origin.

Both answer 404 until these are set on the dashboard process (the proxy needs both, the unsubscribe route needs `MARKETING_URL`):

| Variable | Meaning |
|---|---|
| `MARKETING_URL` | Where the dashboard reaches the worker, e.g. `http://op-marketing:4100` |
| `MARKETING_PROXY_SECRET` | Same value as the worker's |

Roles: every `/marketing-api/*` call is checked against core first. Organization owners and admins can change rules, channels, settings, reference sets and API keys, and read channel configuration; members can read rules, starter rules, settings, results and reference sets, and preview templates. For audiences and campaigns see the role table in "Audiences and campaigns". Contact and device sync are never reachable through the dashboard. The unsubscribe route forwards only the query string, a POST body of at most 64 KiB, `content-type` and `x-forwarded-for` (verbatim), never the proxy secret, and returns only the worker's status, body, `content-type`, `content-security-policy` and `cache-control`.

## Audience source and topology

A project's people can come from two sources, chosen on the Channels tab: `stored` (contacts and devices synced through the sync endpoints) or `http` (the owner's signed audience API: the plugin asks it for counts, pages of ids and, when a step is due, a lookup of up to 500 ids, and keeps no contact data). For an `http` project the contact and device sync routes answer 409 `source_is_http`, and saving the source as `http` deletes that project's stored contacts and devices; its opt-outs (unsubscribes) and dead-token hashes stay. The contract, signing, limits and a conformance suite are in [`docs/AUDIENCE_CONTRACT.md`](docs/AUDIENCE_CONTRACT.md); a runnable reference server is `examples/audience-api-postgres/`. Moving the owner's existing backend journeys onto the plugin is in [`docs/CUTOVER_BACKEND_JOURNEYS.md`](docs/CUTOVER_BACKEND_JOURNEYS.md): read its opt-out warning first.

Intended topology (spec section 3.1): OpenPanel (dashboard, API, Redpanda, ClickHouse) at Hetzner; the marketing worker replicas, the marketing Postgres and Redis in AWS Hyderabad next to the owner's backend. The worker consumes the events topic across the WAN over TLS and SASL, initiated from AWS, and calls the owner's `/internal/audience/**` over signed HTTPS; the dashboard reaches the worker through the existing proxy over HTTPS with the shared secret, and the worker's port is open only to the Hetzner addresses. The worker is a **separate service** from the owner's backend: it never connects to the student database. Set `MARKETING_DATABASE_URL` to a dedicated database in AWS; sharing OpenPanel's database through `DATABASE_URL` stays supported for small installs. Keep the Redpanda topic retention longer than the longest outage you accept (at least 7 days); after an outage, steps later than `MARKETING_MAX_LATENESS` are skipped as `expired`. `scripts/consumer-bytes.ts` measures the WAN bandwidth of the topic.

Source calls: 5 s timeout for `count`, 10 s for the others, 3 attempts with jittered backoff on 5xx and 429, no retry on 401 or 403, responses over 8 MiB rejected, redirects never followed. If the source is down, journey steps stay pending and resume by themselves; nothing is marked failed because of it.

## Audiences and campaigns

The how-to is in the guide, sections 9 and 10. This is the reference. Every route below is a dashboard route (`/marketing/...` on the worker, `/marketing-api/...` through the dashboard proxy). Audiences need the project's `http` audience source; contact details never reach the plugin's tables or logs (`src/engine/pii.test.ts` checks the whole audience and campaign path).

### Audiences

Tables: `marketing.audiences`, `marketing.audience_ids` (hand-picked `include` and `exclude` lists, ids only), `marketing.audience_snapshot_ids` (frozen ids per `snapshot_version`).

- **Blocks.** `filter` (a filter tree over the source's `/schema`: AND/OR groups, depth 3, string values up to 512 characters), the include list, the exclude list and `excludeFilter`. `null` means "no filter" and must be sent explicitly.
- **Precedence.** (filter matches plus include list) minus (exclude list and exclude filter): an exclusion always wins. An exclude list of up to 1,000 ids is sent to the source as an `id not_in` condition (unless that would make the filter deeper than 3); a larger one, and the exclude filter (the contract has no negation), is paged and subtracted by the plugin.
- **Caps.** 20,000 ids per list (`ids_limit`), 2,000 ids per change call (the 1 MiB body cap), 100,000 ids per snapshot (`snapshot_too_large`), 200 inputs per resolve call after trimming blanks and duplicates (`too_many_inputs`; the body may hold up to 1,000 lines).
- **Dynamic or snapshot.** A `dynamic` audience is evaluated when a campaign using it starts. A `snapshot` audience is evaluated by `POST .../freeze`, which pages the source into `audience_snapshot_ids` at the audience's current `version`; every edit bumps `version` and leaves the snapshot stale until the next freeze. Freezing needs the source at that moment; a failed freeze leaves the previous snapshot in place. Freezing an already frozen version does nothing. One freeze per audience runs at a time (Redis key `marketing:audience-freeze:<id>`, 60 s TTL renewed while it runs). A freeze pages the source through the campaign lane (see "Lane priority"), so it cannot take the slot journeys keep; its staging rows are keyed by the audience id, so a crashed freeze's rows are wiped by the next one.
- **Saving never waits on the source.** Create and update check the filter against the live schema with a 2 s limit; when the source is slow, down or not configured, only the structure is checked.
- **In use.** An audience used by a `scheduled`, `running` or `paused` campaign cannot be edited, frozen or deleted (`audience_in_use`). Any campaign referencing it, draft or finished, blocks deletion.
- **Counts.** `count` is the filter's count plus the include list. Overlap between them, and exclusions the source could not apply, are unknown, so the count is an upper bound and `approximate` says so.
- **Unknown hand-picked ids** are not dropped: they stay in the recipient list and are skipped with a reason when a send reaches them (send engine).

| Route | Body | Answer |
|---|---|---|
| `GET /marketing/audience/schema` | none | the source's schema |
| `GET /marketing/audience/dimensions/{key}/values?q=&limit=` | none | `{ values }`, `limit` 1 to 100, default 20 |
| `POST /marketing/audience/resolve` | `{ inputs: string[] }` | `{ ids, unmatchedPositions }`; an input that matches several people matches none |
| `GET /marketing/audiences` | none | `{ audiences }` |
| `POST /marketing/audiences` | `{ name, mode, filter, excludeFilter }` | 201, the audience |
| `GET /marketing/audiences/{id}` | none | the audience (`includeCount`, `excludeCount`, `version`, `snapshotVersion`, `snapshotCount`, `inUse`, ...) |
| `PUT /marketing/audiences/{id}` | the create body plus `expectedVersion` | the audience |
| `DELETE /marketing/audiences/{id}` | none | 204, no body |
| `GET /marketing/audiences/{id}/ids?list=include\|exclude&cursor=&limit=` | none | `{ ids, nextCursor }`, `limit` up to 1,000 |
| `POST /marketing/audiences/{id}/ids` | `{ list, add?, remove?, clear?: true, expectedVersion }` | the audience |
| `POST /marketing/audiences/{id}/count` | none | `{ count, approximate, countedAt, filterCount, includeCount, excludeCount }` |
| `POST /marketing/audiences/{id}/preview` | JSON, `{}` is fine: `{ cursor?, limit? }` (1 to 50, default 20) | `{ members: [{ id, displayName? }], nextCursor, exclusionsApplied }`: filter matches only; `exclusionsApplied` is `false` when an exclude filter exists, because the page may then hold excluded people |
| `POST /marketing/audiences/{id}/explain` | `{ id }` | `{ id, verdict: in\|out, reasons, filter?, excludeFilter? }` |
| `POST /marketing/audiences/{id}/freeze` | none | the audience |

### Campaigns

Tables: `marketing.campaigns`, `marketing.campaign_recipients` (one row per recipient, ids only), `marketing.campaign_counters`, `marketing.campaign_test_sends`, `marketing.materialize_exclusions` (staging while materialising).

| State | Meaning | Actions |
|---|---|---|
| `draft` | Editable (`PATCH` with `expectedVersion`) and deletable | `schedule`, `start`, `count-preview` |
| `scheduled` | Waiting for its send time, or a queued start waiting for the project's slot | `unschedule` (back to draft), `start`, `cancel`, `count-preview`; the scheduler starts it or marks it `missed` |
| `running` | Materialising, then sending; holds the project's slot | `pause`, `cancel`; completes or fails |
| `paused` | Stopped by an operator; **keeps the slot** and keeps materialising, resumes where it stopped | `resume`, `cancel` |
| `completed`, `cancelled`, `failed`, `missed` | Final | none |

Cancel (and a failed campaign) records every recipient not yet being sent as `skipped` with reason `cancelled` (or `failed`).

**Gates**, checked in this order by `start` and `schedule` inside one transaction that locks the campaign and its audience:

1. The state allows the action (`invalid_transition`); the campaign has an audience (`missing_audience`).
2. `schedule` only: `sendAtLocal` (`YYYY-MM-DDTHH:mm`, in the campaign's `timezone`, default `Asia/Kolkata`) is set and valid (`invalid_send_time`) and not in the past (`schedule_in_past`).
3. A snapshot audience is frozen at its current version (`audience_snapshot_stale`).
4. The filter and exclude filter are still valid against the live schema (`invalid_filter`; needs the `http` source: `source_not_http`).
5. The channel is ready: it has a stored credential (`channel_not_configured`), its settings pass (`rate_required` for sms, whatsapp and email; `quota_required` for email), and for sms and whatsapp the template exists, is enabled, maps its variables and belongs to the channel (`template_not_found`, `template_disabled`, `template_mapping_missing`, `template_channel_mismatch`). `channel_not_ready` is only the default of a service built without that check; the worker never answers it.
6. A count preview exists, at most 15 minutes old, made for the current campaign and audience versions (`count_preview_required`).
7. When the preview count is above the campaign's threshold (`MARKETING_CONFIRM_THRESHOLD` when it was created), the body carries `{ "confirm": { "count", "channel" } }` equal to the preview's count and the campaign's channel (`confirmation_required`, with `details: { count, channel }`; `confirmation_mismatch`).

**One active campaign per project.** A `running` or `paused` campaign holds the project's slot (unique index `campaigns_one_active_per_project`). A `start` while the slot is taken passes the same gates, then queues: the campaign becomes `scheduled` with `sendKind: "now"`, and the scheduler starts it when the slot frees. A queued start is never `missed`, and its confirmation counts as given when it was queued: the count is not checked again, so a dynamic audience may have grown by then.

**Schedules and `ifLate`.** Every replica's scheduler claims due campaigns each `MARKETING_TICK_MS` (`FOR UPDATE SKIP LOCKED`, 20 per tick). A scheduled campaign is late once a whole minute has passed beyond its window: late when `now >= send_at + (ifLateMinutes + 1) minutes` (`ifLateMinutes` 0 to 1440, default 60), so `ifLateMinutes: 0` still allows a start within the due minute. A late campaign becomes `missed` with `stateReason: "late"`. A scheduled campaign whose time comes while another campaign holds the slot waits, and is missed if it is still waiting past its window.

**Roles** (dashboard proxy): members may read, create and edit audiences and drafts, resolve, count, preview, explain, freeze and run `count-preview`. Deleting an audience or a campaign, and `start`, `schedule`, `unschedule`, `pause`, `resume`, `cancel` and `test-send`, need an organization owner or admin. A wrong method is 405, an unknown path 404.

| Route | Body | Answer |
|---|---|---|
| `GET /marketing/campaigns` | none | `{ campaigns }` |
| `POST /marketing/campaigns` | `{ name, channel, template, audienceId?, campaignKey?, skipPreviousRecipients?, sendAtLocal?, timezone?, ifLateMinutes?, quietHoursOverride?, frequencyCap? }` | 201, the campaign |
| `GET /marketing/campaigns/{id}` | none | the campaign with `counters { queued, sent, failed, skipped, uncertain }` |
| `PATCH /marketing/campaigns/{id}` | any draft fields plus `expectedVersion` | the campaign; drafts only (`not_draft`) |
| `DELETE /marketing/campaigns/{id}` | none | 204, no body; drafts only |
| `POST /marketing/campaigns/{id}/count-preview` | none | the count (as for an audience); also stored on the campaign with `campaignVersion` and `audienceVersion` |
| `POST /marketing/campaigns/{id}/start`, `/schedule` | none, or `{ confirm: { count, channel } }` | the campaign |
| `POST /marketing/campaigns/{id}/unschedule`, `/pause`, `/resume`, `/cancel` | none | the campaign |
| `POST /marketing/campaigns/{id}/test-send` | `{ profileId }` | `{ id }`: sent by the next test-send tick; at most 10 per campaign per hour (`test_send_limit`) |
| `POST /marketing/campaigns/{id}/retry-uncertain` | none | `{ retried, campaign }` |
| `POST /marketing/campaigns/{id}/estimate` | none | `{ count, channel, ratePerSecond, estimatedSeconds, cost, quota, issues }` |
| `GET /marketing/campaigns/{id}/recipients?status=&cursor=&limit=` | none | `{ recipients, nextCursor }` |
| `GET /marketing/campaigns/{id}/skip-reasons`, `/test-sends` | none | reason counts; test sends |

Channel credentials and settings (`GET|PUT /marketing/channels/{channel}` and `/settings`) and templates (`/marketing/templates...`) are described in the guide, section 10.1 and 10.2. Rows of a campaign can end `sent`, `failed`, `skipped` or `uncertain`; `campaign_counters.queued` counts rows materialised as pending and never decreases. A campaign row also carries `dispatchError` and `dispatchRetryAt` (guide, 10.4).

Action routes accept an empty body; a body with fields the action does not take is `invalid_body`. Responses never carry the materialiser's lease token, lease time, cursor or retry time.

### Materialiser

Every `MARKETING_TICK_MS` each replica claims one campaign that is `running` or `paused` and not yet materialised, with a 60 s lease renewed every 20 s while the run lasts (a slow source call cannot let another replica take it over). It pages the source with `fields=id` (1,000 ids a page): staged exclusions first, then the filter's members, then the include list; a snapshot audience's frozen ids are copied instead. The phase and cursor commit with each page, so a run that stops (shutdown stops after the page in flight) or crashes resumes from the last committed page once the lease is free. A page commits only while the campaign is still `running` or `paused` and the lease is still its own, so a cancel either wins or waits for the page and then skips its rows. With `campaignKey` and `skipPreviousRecipients`, ids already `sent` or `uncertain` in an earlier campaign of the same project and key are recorded as skipped, `already_received` (ids still pending in that earlier campaign are not). When done, `materializeState` is `done`; only then may the send engine claim recipients.

- Source unavailable or busy: `materializeError: "source_unavailable"`, retried after 30 s without spending an attempt. The campaign stays `running`; it is not paused.
- Credentials rejected: `source_auth_failed`, retried after 5 minutes, and the project's source status is set to `source_auth_failed`; a materialisation that finishes sets it back to `ok`.
- Protocol and unexpected errors (`source_protocol_error`, `internal_error`) spend an attempt; after 5 the campaign fails with `stateReason: "materialize_failed"`.
- No `http` source (for example the project was switched to `stored`): the campaign fails at once with `stateReason: "source_not_http"`, since waiting would only hold the project's slot. A snapshot audience's frozen ids are copied without the source, so its campaign still materialises.
- A restart from scratch after recipients were already being sent fails the campaign with `materialize_restart_after_sending` rather than risk duplicates.

Cancelling or failing a campaign also deletes its staging rows in `materialize_exclusions`.

### Lane priority

Campaign calls to the source go through a per-project lane capped at `MARKETING_SOURCE_CONCURRENCY` minus one, on top of the shared cap, so one shared slot is always free for journey lookups. Keep `MARKETING_SOURCE_CONCURRENCY` at 2 or more: at 1 the lane cap is also 1, and a campaign call can hold the only slot while journey steps wait and retry.

### Errors

Error bodies are `{ "error": "<code>", "issues"?: [{ "path", "message" }], "details"?: { ... } }`.

| Status | Code | When |
|---|---|---|
| 400 | `invalid_body`, `invalid_json` | The body does not match the route's schema |
| 400 | `invalid_query` | A path or query parameter is invalid |
| 400 | `invalid_filter` | A filter fails the schema check on save (409 at the campaign gates) |
| 400 | `ids_limit`, `too_many_inputs` | Over 20,000 ids in a list; over 200 resolve inputs |
| 400 | `invalid_campaign`, `invalid_audience` | The merged draft is invalid; the audience is not in this project |
| 400 | `invalid_send_time` | `schedule` without a valid `sendAtLocal` |
| 404 | `not_found` | Unknown id, or another project's |
| 409 | `version_conflict` | `expectedVersion` is stale, or the audience changed during a freeze |
| 409 | `audience_in_use` | See "In use" |
| 409 | `not_snapshot` | `freeze` on a dynamic audience |
| 409 | `freeze_in_progress`, `freeze_lock_lost` | Another freeze of the audience runs; this freeze lost its lock and was discarded |
| 409 | `snapshot_too_large` | Over 100,000 ids |
| 409 | `source_not_configured`, `source_not_http` | No audience source; the source is `stored` |
| 409 | `source_auth_failed` | The source rejected the credentials |
| 502 | `source_error` | The source's answer broke the contract |
| 503 | `source_unavailable` | The source is down or busy |
| 409 | `not_draft`, `invalid_transition` | Edit or delete of a non-draft; an action the state does not allow |
| 409 | `missing_audience`, `audience_snapshot_stale`, `schedule_in_past`, `channel_not_configured`, `rate_required`, `quota_required`, `template_not_found`, `template_disabled`, `template_mapping_missing`, `template_channel_mismatch` | Gates 1 to 5 |
| 409 | `quota_spread_required` | An email campaign larger than today's remaining quota; resend `confirm` with `spreadOverDays: true` |
| 409 | `count_preview_required`, `confirmation_required`, `confirmation_mismatch` | Gates 6 and 7 |
| 429 | `test_send_limit` | 10 test sends per campaign per hour |

Campaign `stateReason` values: `late` (missed), `materialize_failed`, `materialize_restart_after_sending`, `source_not_http`, `source_error`, `template_unavailable`, `template_not_found`. `dispatchError` values: `source_unavailable`, `source_auth_failed`, `channel_auth_failed`, `channel_not_configured`, `quota_exhausted`.

### Known limits

- MSG91 has not been called for real (no access yet): the WhatsApp per-recipient response shape, whether a 400 or 422 can partly accept a request and the 100-recipient limit are unverified (guide, 10.2).
- No email provider is configured yet: email is built and tested against a fake SMTP server only, and opt-out handling for campaigns beyond the unsubscribe link is deferred (guide, 10.3).
- Campaign sends are at most once; `uncertain` rows are re-sent only by an operator (guide, 10.6).
- Confirmation is checked when a start is queued, not again when the queued campaign starts.
- A paused campaign keeps the project's slot, so other campaigns of the project queue (or, if scheduled, can be missed) until it is resumed and finishes, or is cancelled.
- A source outage never pauses a campaign; it shows as `materializeError` while the campaign stays `running`.

## Deploy

The worker image is `packages/marketing/Dockerfile`, built from the repository root:

```bash
docker build -f packages/marketing/Dockerfile -t openpanel-marketing:local .
```

It runs `bun src/worker.ts` as the non-root `bun` user, applies the plugin's own migrations (schema `marketing`, under a Postgres advisory lock so replicas can boot together) at start, serves `/marketing/*` on `MARKETING_PORT` and has a `HEALTHCHECK` on `GET /marketing/health`, which answers 503 while the marketing database does not answer a `SELECT 1`. No secret is baked in; Prisma's client is generated with a placeholder URL. Build from a clean checkout: the root `.dockerignore` (which the plugin may not edit) does not exclude `.worktrees/`, so building from a main checkout that has worktrees sends all of them as build context.

`docker-compose.marketing.yml` (repository root) is an override for the self-hosted stack, the `docker-compose.yml` that `openpanel init` renders from `self-hosting/docker-compose.template.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.marketing.yml up -d --build
```

`openpanel init` does not know about it: copy the file next to your `docker-compose.yml` and add `-f docker-compose.marketing.yml` to every compose command, upgrades included. It:

- adds `op-marketing` (port 4100 on the compose network only, not published; waits for healthy `op-db`, `op-kv` and `op-rp`);
- **replaces the dashboard image with one built from this fork** (`apps/start/Dockerfile`). The stock `lindesvard/openpanel-dashboard` image has no marketing pages, no `/marketing-api/*` proxy and no `/marketing/unsubscribe` route, so with it the feature is invisible and every unsubscribe link 404s. Build the dashboard from the same upstream release your `op-api` image runs, so the two stay compatible;
- merges `MARKETING_URL=http://op-marketing:4100` and `MARKETING_PROXY_SECRET` into `op-dashboard`.

Both built services use `pull_policy: build`, so compose builds them instead of trying to pull a local tag. The service names are the `openpanel init` ones. `self-hosting/coolify.yml` names its services differently (`opdashboard`, `opdb`, ...), so on Coolify add the equivalent service and dashboard variables by hand. The repository's development `docker-compose.yml` has no dashboard service and no healthchecks, so in development run `bun run --filter @openpanel/marketing start` instead of the override.

Values come from the install's `.env`, which already has `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY` and `KAFKA_BROKERS`. Add:

- `MARKETING_PROXY_SECRET` (`openssl rand -hex 32`); compose refuses to start without it.
- `MARKETING_PUBLIC_URL`: the public dashboard origin (the same as `DASHBOARD_URL`), so links in emails hit the dashboard's `/marketing/unsubscribe`; compose refuses to start without it.
- Optional: `MARKETING_IMAGE` (default `openpanel-marketing:local`), `MARKETING_DASHBOARD_IMAGE` (default `openpanel-dashboard-marketing:local`), `MARKETING_BUILD_CONTEXT` (default `.`; set it to a checkout of this repository when running compose from an install directory).

No change to the stock Caddy (or Coolify) configuration is needed: both marketing paths are served by the dashboard. Unsubscribe requests travel client -> edge proxy -> dashboard -> worker. The edge proxy sets `X-Forwarded-For` to the client address and the dashboard passes it on unchanged, so the override sets `MARKETING_TRUST_PROXY=true` and the worker rate-limits by the real client. That is only sound while `op-marketing` stays unpublished and the dashboard is reached through the edge proxy: a client that can reach the dashboard (or the worker) directly can choose its own `X-Forwarded-For` and so its own rate-limit bucket. With `false`, every unsubscribe caller shares the dashboard's address and therefore one limit for invalid tokens (valid links are never limited).

Optional, direct to the worker instead of through the dashboard: only if you want the worker's sync endpoints (`/marketing/contacts/*`, `/marketing/devices`, `/marketing/reference-sets/*`) reachable from outside the compose network, route them in Caddy yourself, before `handle_path /api*`:

```caddyfile
@marketing_sync path /marketing/contacts/* /marketing/devices /marketing/reference-sets/*
handle @marketing_sync {
    reverse_proxy op-marketing:4100
}
```

## Upgrading from upstream

The plugin only adds files (see `AGENTS.md`, "Fork discipline"), so an upstream merge conflicts only in the touchpoints listed in `TOUCHPOINTS.md`:

1. `apps/start/src/components/sidebar-project-menu.tsx`: keep the one `<SidebarLink ... href={'/marketing'} ... label="Marketing" />` element; if upstream dropped `WorkflowIcon` from the imports, stop and ask rather than editing the import block.
2. `apps/start/src/routeTree.gen.ts` and `bun.lock`: take upstream's, then regenerate (`bun install`, and the dashboard's dev server or build for the route tree).

Afterwards run the plugin tests and `bun run typecheck`, and check `git diff --name-status <upstream>..HEAD` shows only added files besides those.

### Plugin upgrade notes

- **Campaign sending (config now fails at startup).** Each replica now runs `MARKETING_CAMPAIGN_CONCURRENCY` campaign send loops (new optional variable, default 2), a reaper for expired recipient leases and the test-send job, every `MARKETING_TICK_MS`. `MARKETING_DB_POOL` must now be at least `MARKETING_SEND_CONCURRENCY` + `MARKETING_CAMPAIGN_CONCURRENCY` + 3, or the worker refuses to start. The defaults (10 + 2 + 3 = 15) still boot; a pool of 13 or 14 that booted before must be raised. Like the journey ticker, campaign sends and test sends only run when the signed unsubscribe link is configured.
- **Send engine: migrations 0014 and 0015.** 0014 (`channel_settings_templates`) only creates the tables for channel settings and SMS/WhatsApp templates. 0015 (`send_ledger_dispatch`) adds the send ledger and dispatch columns, **backfills 400 days of journey sends into `marketing.send_ledger`** from `marketing.steps`, and builds an index on `marketing.campaign_recipients (lease_token)` **without `CONCURRENTLY`**, which blocks writes to that table while it builds; on an install with a large recipient table expect the first start to take longer, and start with no campaign running.
- **Rolling deploys undercount frequency caps.** Journey sends now write a ledger row. While old replicas still run during a rolling deploy they send journey steps without one, so frequency caps count too few sends for that overlap; stop the old replicas first if that matters.
- **The journey frequency cap now reads the shared ledger** (journeys and campaigns together) instead of counting steps; `caps` gains `scope: "channel" | "all"` (default `"channel"`).
- **Channels need a configuration row to start a campaign.** Push, email and webhook campaigns now answer `channel_not_configured` until the channel has a stored credential; email also needs `ratePerSecond` and `dailyQuota` in its channel settings (`rate_required`, `quota_required`).
- **New channels: SMS and WhatsApp (MSG91).** Credentials are `{ authKey, baseUrl? }` for `sms` and `{ authKey, integratedNumber, baseUrl? }` for `whatsapp`, set through `PUT /marketing/channels/{channel}`; both need `ratePerSecond` and an approved template (guide, 10.2).
- **Redis 5 or newer is required** (the pacing scripts read the server clock and then write).
- Migration 0005 adds `marketing.enrollments.end_reason`. Journeys that ended before it have no end reason, so after the upgrade they count as not converted: "Completed after send" and conversion start low and only count journeys that end afterwards.
- **Failure texts are redacted.** Recipient values (email, device tokens, longer attribute values) are replaced by `[redacted]` in stored and logged send-failure reasons, for stored projects too.
- **Lease rule (config now fails at startup).** `MARKETING_LEASE_SECONDS` must exceed `MARKETING_LOOKUP_WINDOW_MS` / 1000 + 31. With the default 2,000 ms window that is more than 33, so configs of 32 or 33 s that used to boot are now rejected; raise it (the default 120 is fine).
- **Expired steps (behaviour change).** A step that is more than `MARKETING_MAX_LATENESS` (default 86,400 s) past its scheduled time is skipped as `expired` instead of sent, for the `stored` source as well. Lateness is measured from the scheduled time (migration 0010, `marketing.steps.scheduled_at`), not from the last retry, so a step an audience source kept deferring through an outage also expires. After a long outage, steps older than a day are no longer sent late.
- Migrations 0007 (`marketing.audience_sources`), 0008 (source status columns) and 0009 (`marketing.dead_tokens`: hashes of push tokens FCM reported dead, purged after 90 days) are additive and fast. Migration 0010 adds the nullable column `marketing.steps.scheduled_at` without rewriting existing rows (fast); steps created before it fall back to `due_at` for expiry.
- Migrations 0011 (`marketing.audiences`, `marketing.audience_ids`, `marketing.audience_snapshot_ids`) and 0012 (`marketing.campaigns` with the unique index `campaigns_one_active_per_project`, `marketing.campaign_recipients`, `marketing.materialize_exclusions`, `marketing.campaign_counters`, `marketing.campaign_test_sends`) only create new tables and indexes, so they are fast and change nothing for journeys. New optional variable: `MARKETING_CONFIRM_THRESHOLD` (default 5000). Each replica now also runs the campaign scheduler and materialiser every `MARKETING_TICK_MS`; with no campaigns they do one cheap query each. Campaign materialisation uses the audience source alongside journeys, so set `MARKETING_SOURCE_CONCURRENCY` to at least 2 (the default 4 is fine). Migration 0013 adds a partial index on `marketing.campaign_recipients (campaign_id)` for unfinished rows; it is built at startup and is fast on an empty or small table.
- Migration 0006 builds an index on `marketing.events (event_time)` inside the startup migration. It locks writes to `marketing.events` while it builds, so on a large table expect the first start to take longer.

## End-to-end check

`scripts/e2e.ts` proves the whole path on a running stack: it creates an active rule through the worker's dashboard API (trigger `add_to_cart`, goal `purchase`, one webhook step at +10 s), points the project's webhook channel at a local receiver, sends `add_to_cart` for a fresh profile through `POST $API_URL/track`, and expects exactly one delivery whose `x-marketing-signature` verifies against the channel secret. Then it sends `add_to_cart` and, a second later, `purchase` for another profile and expects no delivery. It prints `PASS delivered once`, `PASS signature verifies` and `PASS cancelled by goal`, and exits non-zero on any failure.

```bash
bun run dock:up                                  # Postgres, Redis, ClickHouse, Redpanda
bun run --filter @openpanel/api dev              # the API, with its worker role
MARKETING_GRACE_SECONDS=1 MARKETING_TICK_MS=1000 MARKETING_WEBHOOK_ALLOW_HOSTS=localhost \
  MARKETING_PROXY_SECRET=... MARKETING_PUBLIC_URL=http://localhost:4100 KAFKA_EVENTS_TOPIC=events \
  bun run --filter @openpanel/marketing start        # plus DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, KAFKA_BROKERS
MARKETING_URL=http://localhost:4100 MARKETING_PROXY_SECRET=... API_URL=$API_URL \
  E2E_PROJECT_ID=... E2E_CLIENT_ID=... E2E_CLIENT_SECRET=... DATABASE_URL=$DATABASE_URL \
  bun packages/marketing/scripts/e2e.ts
```

- Project and client ids come from `.seed.json` (a project whose client may send `profileId`, e.g. `acme-shop`).
- `MARKETING_GRACE_SECONDS` must be at least 1 (the config rejects 0).
- The receiver's host (`E2E_RECEIVER_HOST`, default `localhost`) must be in the worker's `MARKETING_WEBHOOK_ALLOW_HOSTS`, because plain http is only allowed for listed hosts.
- It assumes the project has no quiet hours and no frequency caps in its marketing settings; either can hold the delivery back past the timeout.
- The script refuses a project that already has a webhook channel, because there is no API to restore it; use a dedicated project or set `E2E_ALLOW_WEBHOOK_OVERWRITE=true`. Afterwards the channel stays configured, pointing at the stopped receiver.
- It deletes its rule through the API and, when `DATABASE_URL` is set, the rule's enrollments and steps and the e2e profiles' rows in `marketing.events`. The two `marketing-e2e-*` profiles stay in core's ClickHouse.
- A failed cleanup step is reported and makes the run exit non-zero, but never hides an earlier `FAIL`.
- It never prints the proxy secret, client secret or webhook secret.

## Operations

- **Scaling.** The worker is one role: consumer, ticker, purge and HTTP API in one process. Run more replicas of the same service; they join one consumer group (`MARKETING_KAFKA_GROUP`) and split the topic's partitions, so replicas beyond the partition count idle on the consumer side. The ticker is safe on every replica (claims use row leases, `MARKETING_LEASE_SECONDS`). Each replica opens up to `MARKETING_DB_POOL` Postgres connections to the marketing database; only when it falls back to core's `DATABASE_URL` do they count against core's `max_connections`.
- **Interest set.** Profiles with active enrollments are kept in Redis (`marketing:interest:profiles`), shared by all replicas and added the moment a profile enrolls. The event names that matter (triggers and goals of active rules) are held in each replica's memory; both are rebuilt from Postgres every 10 s, and right after a rule change through the API on the replica that handled it, so other replicas see a new rule within 10 s.
- **Capacity.** One local run of `scripts/load.ts` (Postgres 14 and Redis 7 in Docker on a Windows laptop) measured about 2,000 events/s per replica when 95% of events are pre-filtered out, and about 350 events/s for a project with an active inactivity rule, where every identified event is written (see "Event pre-filter trade-off"). The numbers are indicative, not guarantees. Plan replicas >= topic events/s / 2,000, or / 350 for the share of traffic from projects with an inactivity rule, and never more replicas than the topic has partitions (extra replicas idle on the consumer side). One replica's ticker sends a 200-step batch per tick; see `scripts/load.ts` output for the current per-tick time.
- **Lag gate.** Every 10 s the worker writes the group's total lag to `marketing.consumer_state`. The ticker sends nothing while that lag is above `MARKETING_MAX_LAG` or the value is older than 60 s, so a backlog never produces journey messages whose goal events are still unread. The gate pauses sending; it does not shed work while it is short: due steps wait and go out once the consumer catches up. If the gate stays closed longer than `MARKETING_MAX_LATENESS`, steps more than that past their scheduled time are skipped as `expired` when it reopens. While it is closed the worker logs `sending paused` at most once a minute with the lag, the threshold and the state's age.
- **Outage longer than topic retention.** If the worker is down longer than the topic keeps messages, the consumer group's offsets point at deleted data and it restarts at the latest offset, so lag drops to 0 and the gate reopens, although the goal events of that window were never read. Steps that come due then can message people who already reached the goal. Before restarting after such an outage, pause the affected rules (or accept that goal events from the gap were lost).
- **Event retention.** Every hour each replica deletes `marketing.events` rows older than `MARKETING_EVENT_RETENTION_DAYS`, in chunks of 10,000 with a short pause between them, until nothing old is left or the run has used 10 minutes; the next hourly run continues where it stopped. Events a live enrollment may still read (at or after an active enrollment's trigger for that profile) are kept until that enrollment ends. Old rows are found through `events_event_time_idx` (migration 0006).
- **Heal sweep.** Once a minute each replica's ticker looks for enrollments whose last step is final but whose completion write failed, and completes up to 200 of them. Its cost grows with the number of active enrollments: about 7-8 s at 100,000 in the local load run, which delays that one tick. Follow-ups: run it on one replica only (`pg_try_advisory_lock`), or look only at recently finished steps.
- **History retention is not implemented.** `marketing.enrollments` (with each rule snapshot) and `marketing.steps` grow without bound. Purge finished journeys by hand when needed, for example older than 180 days, with this one statement (add `AND e.project_id = '...'` to limit it to one project):

  ```sql
  WITH gone AS (
    DELETE FROM marketing.enrollments e
    WHERE e.status IN ('completed', 'cancelled')
      AND e.created_at < now() - interval '180 days'
      AND (e.status = 'cancelled'
           OR NOT EXISTS (SELECT 1 FROM marketing.rules r
                          WHERE r.id = e.rule_id
                            AND (r.definition->'reentry'->>'enabled')::boolean IS NOT TRUE))
    RETURNING e.id
  )
  DELETE FROM marketing.steps WHERE enrollment_id IN (SELECT id FROM gone);
  ```

  Completed journeys of rules with re-entry disabled are kept on purpose: that completed row is what stops the rule from enrolling the same person again, so deleting it would message them a second time. Keep the age above 90 days, the longest re-entry cooldown, so a purge never shortens a cooldown. If you later turn re-entry off on a rule, completions purged while it was on no longer block re-enrollment. Purged journeys also disappear from the Results screen. `src/engine/history-purge.test.ts` runs this exact block.
- **Revoking an API key.** There is no revoke endpoint yet: `DELETE FROM marketing.api_keys WHERE id = '<key id>';` (the id is the part of the key before the dot). Each replica caches a valid key for up to 5 minutes, so a revoked key keeps working for at most that long; restart the replicas to cut it off at once.
- **Push opt-out.** Unsubscribe links exist for email only; push has no opt-out path in the plugin. Suppress push for a user in your own backend, or delete their device tokens (`DELETE /marketing/devices`).
- **SMTP host.** The email channel's host is set by organization admins in the dashboard, and the worker connects to it from inside your network, so treat that setting as trusted-admin-only (an admin could point it at an internal address). With `secure: false` the connection starts in plain text and upgrades only if the server offers STARTTLS; against a server without STARTTLS the SMTP credentials go over the wire unencrypted.
- **Healthcheck window.** The HTTP server (and `/marketing/health`) starts last, after migrations and the first interest refresh, which took about 7 s for 100,000 active profiles. The image's healthcheck allows a 30 s start period; with millions of active profiles raise `start_period` in your compose override.
- **Pre-filter.** See below for when the pre-filter stores every identified event.

Fork rules and touchpoints: see `AGENTS.md` and `TOUCHPOINTS.md`.

## Event pre-filter trade-off

The consumer drops most events before touching Postgres: it keeps an event when its name is a trigger or goal event of a live rule, or when its profile has an active enrollment. In a project with at least one active rule whose goal is `inactivity`, it keeps every event that carries a profile id instead. Events for one profile arrive on different Kafka partitions, so an activity event can reach a replica before the trigger that enrolls the profile. Without this rule that activity would be dropped and the inactivity marketing would go out anyway. The cost is that those projects store all identified events in `marketing.events` (bounded by `MARKETING_EVENT_RETENTION_DAYS`), and the pre-filter saves nothing for them. Anonymous events (no profile id) are always ignored.
