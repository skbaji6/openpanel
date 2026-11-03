# Marketing: setup and integration guide

This guide takes you from nothing to a working marketing. The reference for every environment variable, the operations notes and the upgrade notes are in [`../README.md`](../README.md). This guide does not repeat them.

## 1. What it is

Marketing is an optional add-on for OpenPanel. It is a separate service (`op-marketing`) plus a few dashboard pages. It does not change OpenPanel's own code paths: it reads the same events topic as OpenPanel, with its own Kafka consumer group, and keeps its own tables in the Postgres schema `marketing`.

A **rule** says: *when event A happens for a person, and goal G does not happen within time T, send a message*. A rule has one or more timed **steps**; each step sends one message over one **channel** (email, webhook or Firebase push).

```
 your apps ──SDK──▶ OpenPanel /track ──▶ Kafka "events" topic
                                              │ (own consumer group "marketing")
                                              ▼
  your backend ──sync API──▶  op-marketing (consumer + ticker + HTTP API) ──▶ email (SMTP)
  (contacts, devices,              │            │                      ├─▶ webhook (signed POST)
   reference sets)                 │            └─ Postgres "marketing"    └─▶ Firebase push
                                   ▲                Redis (interest set)
  dashboard  ──/marketing-api/*────────┘
  (Marketing pages, unsubscribe page)
```

Example: an ed-tech app. Rule "added a book to the cart, did not buy": trigger `add_to_cart`, goal `purchase`, matched on `item_id`, step 1 email after 1 hour, step 2 push after 1 day. If the person buys within the hour, nothing is sent.

## 2. Concepts

| Term | Meaning |
|---|---|
| Trigger | The event that starts a journey for a person (optionally filtered by event properties). |
| Goal | What ends it. `event`: a named event happens. `set`: an event happens for every value in a reference set (for example every section of a book). `inactivity`: the person does nothing (other than listed excluded events) after the trigger. |
| `matchOn` | A trigger property (for example `item_id`). The goal must carry the same value, so opening a section of *the same book* counts, but another book does not. |
| Steps | Up to 20, each with a delay from the trigger (strictly increasing), a channel and a template. |
| Re-entry | Whether the same person can be enrolled again, and after what cooldown. |
| Reference set | A named list of values you register (for example the section ids of one book) that a `set` goal compares against. Snapshotted when a person is enrolled. |
| Contact | A person's email and attributes, synced from your backend. Attributes feed `{{profile.*}}`. |
| Device | A person's Firebase token, synced from your backend. |
| Grace window | `MARKETING_GRACE_SECONDS` (default 300): a goal seen this late still cancels a pending step. |
| Caps, quiet hours | Per project: at most N journey messages per period per person, and no sends in a time window. |
| Audience | A saved selection of people from the `http` audience source: a filter, hand-picked ids to include, ids and a filter to exclude. Dynamic (evaluated when a campaign starts) or snapshot (ids frozen on request). |
| Campaign | A one-off message to an audience over one channel, started now or at a scheduled time. This version builds the recipient list; sending it is the send engine's job, which comes next. |

Only **identified** events (events that carry a `profileId`) take part. Anonymous events are ignored.

## 3. Prerequisites

- A running OpenPanel with Redpanda/Kafka, Postgres and Redis (the standard self-hosted stack has all of them).
- Your apps already send events to OpenPanel with a stable `profileId` (the user id) set through `identify` or the event payload.
- For email: an SMTP account. For push: a Firebase project and a service-account JSON. For webhooks: an HTTPS endpoint in your backend.
- Docker, or Bun 1.4+ for running from source.

## 4. Start it

### 4a. Self-hosted stack (Docker Compose)

1. Get this fork's checkout next to your install, or set `MARKETING_BUILD_CONTEXT` to it.
2. Copy `docker-compose.marketing.yml` next to your `docker-compose.yml`.
3. Add two values to your `.env`:
   ```
   MARKETING_PROXY_SECRET=<output of: openssl rand -hex 32>
   MARKETING_PUBLIC_URL=https://analytics.example.com   # the public dashboard origin
   ```
   `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY` and `KAFKA_BROKERS` are already in an OpenPanel `.env`. Do not change `ENCRYPTION_KEY` later: channel secrets and unsubscribe links depend on it.
4. Start:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.marketing.yml up -d --build
   ```
5. Check it: `docker compose logs op-marketing` shows the migrations and the consumer joining, and `docker compose ps` shows `op-marketing` healthy.

The override also replaces the dashboard image with one built from this fork. The stock dashboard image has no Marketing pages and would 404 every unsubscribe link. Details: README, "Deploy".

Keep using `-f docker-compose.marketing.yml` on every later compose command, upgrades included (`openpanel init` does not know about it).

### 4b. From source (development)

```bash
bun install
bun run dock:up                       # Postgres, Redis, ClickHouse, Redpanda
export DATABASE_URL=... REDIS_URL=... ENCRYPTION_KEY=... KAFKA_BROKERS=... KAFKA_EVENTS_TOPIC=events
export MARKETING_PROXY_SECRET=$(openssl rand -hex 32) MARKETING_PUBLIC_URL=http://localhost:3000
bun run --filter @openpanel/marketing start      # migrates, then serves on :4100
```

For the dashboard pages, give the dashboard process `MARKETING_URL=http://localhost:4100` and the same `MARKETING_PROXY_SECRET`. Without them `/marketing-api/*` and `/marketing/unsubscribe` answer 404.

Run the tests with `cd packages/marketing && bun test --isolate` (needs Postgres, Redis and Kafka reachable; use a database whose name ends in `_test`).

## 5. Connect it

There are four connection points: events (already done by OpenPanel), the dashboard, the audience source and, for the stored source, the sync API from your backend.

### 5a. Events

Nothing to configure. The worker consumes the topic named by `KAFKA_EVENTS_TOPIC` with the consumer group `MARKETING_KAFKA_GROUP`. Make sure your SDK events carry the user's `profileId`, and use the same event names in your rules as you send (for example `add_to_cart`, `purchase`, `section_opened`).

### 5b. Dashboard

Open a project: the sidebar has **Marketing** with four tabs: Journeys, Channels, Results and How it works.

- **Journeys**: create from a starter or from scratch, as a vertical timeline with one form per step. Activate or pause. Preview templates with sample data.
- **Channels**: the audience source (5c), email (SMTP), push (Firebase service account) and webhook (URL plus secret), plus the project's caps, quiet hours and API keys.
- **Results**: per rule: enrolled, messaged, sent, completed after send, conversion, skipped, failed.
- **How it works**: this guide, in short.

Organization owners and admins can change things; members can read and preview.

### 5c. The audience source

Each project gets its people from one source, set on the Channels tab:

- **Stored**: your backend pushes contacts and devices to the sync API (5d). Simple; the plugin holds the contact data.
- **HTTP**: you run the audience API of `docs/AUDIENCE_CONTRACT.md` and register its base URL, key id and secret (a saved secret is kept only while the base URL and key id stay the same; change either and enter the secret again). The plugin stores only the encrypted secret and, per send, ids and a status; it asks your API for contact details one batch at a time and discards them. Use this when student data must stay in your system. Saving the source as HTTP deletes the contacts and devices synced for that project (unsubscribes stay), and the sync API then answers `409 source_is_http` for contacts and devices. The Channels tab shows whether the source is healthy, failing authentication or failing otherwise. Verify your API first with the conformance suite (`conformance/README.md`); `examples/audience-api-postgres/` is a working reference.

With the HTTP source, steps that come due are grouped (up to 500 ids, waiting at most `MARKETING_LOOKUP_WINDOW_MS`, default 2 s), looked up and sent; a person returned as not found, suppressed or unreachable is recorded as skipped with that reason. A step more than `MARKETING_MAX_LATENESS` (default one day) past its scheduled time is skipped as `expired`, for both sources, including a step the audience source kept deferring during an outage. While the source fails, the Channels tab says so and journeys wait.

### 5d. Your backend (server to server, stored source)

Your backend talks to the worker with a project **API key**. Device registration is server-to-server only; apps never call these endpoints.

Create a key on the Marketing, Channels tab. It is shown once and looks like `<id>.<secret>`. Send it as the header `x-marketing-api-key`. The worker's URL is `MARKETING_URL` (inside the compose network `http://op-marketing:4100`). To call it from outside the network, route `/marketing/contacts/*`, `/marketing/devices` and `/marketing/reference-sets/*` to the worker (README, "Deploy").

```bash
H='x-marketing-api-key: <id>.<secret>'
U=http://op-marketing:4100

# Contact: email and attributes used by {{profile.*}} (re-send whenever they change)
curl -X PUT $U/marketing/contacts/user_123 -H "$H" -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","attributes":{"firstName":"Ada","plan":"free"}}'

# Device: Firebase token (platform: android | ios). Re-registering moves a token to the new person.
curl -X PUT $U/marketing/devices -H "$H" -H 'content-type: application/json' \
  -d '{"profileId":"user_123","token":"<fcm token>","platform":"android"}'

# Remove a device (for example at logout)
curl -X DELETE $U/marketing/devices -H "$H" -H 'content-type: application/json' -d '{"token":"<fcm token>"}'

# Reference set: for "opened every section of this book" goals
curl -X PUT $U/marketing/reference-sets/book-42-sections -H "$H" -H 'content-type: application/json' \
  -d '{"values":["intro","ch1","ch2","ch3"]}'
```

Notes:
- The token endpoint answers 409 if that token already belongs to another project.
- A person with no contact email gets no email step; a person with no device gets no push. These steps are recorded as skipped, not failed.
- You own consent. The plugin sends to whoever you sync and honours its own email unsubscribe links. Push has no opt-out inside the plugin: stop syncing the device, or delete it.
- If your users live in two databases, sync contacts and devices from your own user service whenever a user registers, changes email or logs in on a new device.

### 5e. Where it runs, and its own database

The recommended production layout is a separate service close to your own backend, not inside it: OpenPanel at Hetzner; marketing workers, their Postgres and Redis at AWS Hyderabad; the worker consumes the events topic over TLS and SASL from AWS and calls your `/internal/audience/**` over signed HTTPS. Workers scale as replicas of one service (consumer, ticker and API together) and never touch your student database. Give them a dedicated database with `MARKETING_DATABASE_URL` (it falls back to `DATABASE_URL`, which shares OpenPanel's database: fine for small installs). The README, "Audience source and topology", has the details and the variables `MARKETING_SOURCE_CONCURRENCY`, `MARKETING_LOOKUP_WINDOW_MS` and `MARKETING_MAX_LATENESS`.

## 6. Configure the channels

Open Marketing, Channels. Saved secrets are shown masked (`********`); leave a masked field unchanged to keep it.

### Email

SMTP `host`, `port`, `secure` (true for SMTPS on 465; false uses STARTTLS when the server offers it), `user`, `pass`, `from`. Every email carries an unsubscribe link and `List-Unsubscribe` headers, pointing at `MARKETING_PUBLIC_URL/marketing/unsubscribe`.

### Push (Firebase)

Paste the Firebase **service account JSON** (Firebase console, Project settings, Service accounts, Generate new private key). Tokens that Firebase reports as invalid are removed automatically.

### Webhook (your backend delivers)

Set the `url` (https only, or http for hosts in `MARKETING_WEBHOOK_ALLOW_HOSTS`) and one or two `secrets` (16+ characters; the first signs, a second is kept during rotation). The worker POSTs JSON:

```json
{ "projectId": "...", "profileId": "user_123", "channel": "webhook",
  "subject": "...", "title": "...", "body": "...",
  "ruleId": "...", "enrollmentId": "...", "stepIndex": 0 }
```

with headers `x-marketing-timestamp`, `x-marketing-signature` and `idempotency-key`. Verify like this before acting, and de-duplicate on `idempotency-key`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, ts: string, sig: string, secret: string) {
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected), b = Buffer.from(sig);
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && a.length === b.length && timingSafeEqual(a, b);
}
```

Answer 2xx to accept. 429 and 5xx are retried; other statuses count as failed. Your backend then sends the actual email or push in its own way.

## 7. Create a rule

In the dashboard, or by API (the dashboard proxy forwards to these; they need the dashboard's authorization). A rule definition:

```json
{
  "name": "Added to cart, not bought",
  "trigger": { "event": "add_to_cart" },
  "matchOn": "item_id",
  "goal": { "kind": "event", "event": "purchase" },
  "steps": [
    { "delaySeconds": 3600,  "channel": "email",
      "template": { "subject": "You left something behind",
                    "body": "<p>Hi {{profile.firstName}}, {{event.item_name}} is still in your cart.</p>" } },
    { "delaySeconds": 86400, "channel": "push",
      "template": { "subject": "Still interested?", "body": "{{event.item_name}} is waiting for you." } }
  ],
  "reentry": { "enabled": true, "cooldownSeconds": 604800 },
  "allowedEventProps": ["item_name"]
}
```

Goal variants:

```json
{ "kind": "event", "event": "purchase" }
{ "kind": "set", "event": "section_opened", "property": "section_id", "setKey": "book-42-sections" }
{ "kind": "inactivity", "excludeEvents": ["session_start"] }
```

For a `set` goal with `matchOn`, the set is looked up by the matched value (for example per book) and falls back to `setKey`. The set is snapshotted at enrollment; later edits apply to new enrollments only.

**Templates.** `{{profile.<attribute>}}` reads the contact attributes you synced. `{{event.<property>}}` reads the trigger event's property, and only properties listed in `allowedEventProps` render; anything else renders empty. `{{missing}}` lists the set values not yet seen. Values are HTML-escaped in email bodies and plain in subject, push and webhook text. `{{event.*}}` renders only in plain text inside an email body, never inside tags, links, scripts or styles. Use the preview in the editor to check.

**Rules** are created paused unless you set `status: "active"`. Pausing cancels the rule's running journeys. Editing a rule changes only new enrollments. Only a paused rule can be deleted.

Starter rules ship for the four common cases: cart abandoned, registered but not bought, bought but never opened, opened but sections untouched. Their event names are placeholders; edit them to your own.

## 8. Project settings

Marketing, Channels tab (or `PUT /marketing/settings`):

```json
{ "caps": { "max": 3, "periodSeconds": 604800 },
  "quietHours": { "start": "21:00", "end": "08:00", "timezone": "Asia/Kolkata" } }
```

`caps` limits journey messages per person per period; `null` for none. Quiet hours hold messages until the window ends. A step that is held or capped is recorded as skipped (visible in Results).

## 9. Audiences

Audiences need the project's audience source set to `http` (5c); without it the audience calls that ask the source answer 409 `source_not_configured` or `source_not_http`. Routes, limits and error codes are in the README, "Audiences and campaigns".

1. **Filter.** Read the dimensions from `GET /marketing/audience/schema` and the values for a dropdown from `GET /marketing/audience/dimensions/{key}/values?q=`. Combine conditions with AND/OR, up to 3 levels deep.
2. **Include specific people.** Paste phone numbers or emails into `POST /marketing/audience/resolve` (`{ "inputs": [...] }`, up to 200 after blanks and duplicates are dropped). You get back ids, plus the positions of lines that matched nobody or more than one person; the contact values are never stored or logged. Add the ids with `POST /marketing/audiences/{id}/ids` `{ "list": "include", "add": [...], "expectedVersion": n }`. Send at most 2,000 ids per call and repeat for longer lists (a list holds up to 20,000); each call returns the audience with its new `version`, which the next call needs.
3. **Exclude.** The same route with `"list": "exclude"`, and an `excludeFilter` on the audience. Exclusions always win: someone hand-picked and excluded is out.
4. **Check.** `POST .../count` for the live count (an upper bound when `approximate` is true), `POST .../preview` with `{}` for a page of matching ids and masked names (fetched on demand, never stored), and `POST .../explain` with `{ "id": "..." }` for why one person is in or out.

**Dynamic or snapshot.** A dynamic audience is evaluated each time a campaign using it starts. A snapshot audience is evaluated only when you call `POST .../freeze`, after your edits: the ids are frozen (up to 100,000), and every later edit makes the snapshot stale until you freeze again. Freezing needs the source to answer at that moment; if it is down, the freeze fails and the previous snapshot stays. Saving an audience never waits for the source.

While a campaign that uses an audience is scheduled, running or paused, the audience is locked (`audience_in_use`): it cannot be edited, frozen or deleted. To change the selection, unschedule or cancel that campaign, or create another audience.

## 10. Campaigns

A campaign sends one message to an audience over one channel. In this version a campaign is drafted, checked and started, and its recipient list is built ("materialised"); the send engine that delivers it comes next, so nothing is delivered yet.

1. **Draft** (`POST /marketing/campaigns`): name, channel (`push`, `email`, `webhook`; `sms` and `whatsapp` can be drafted but not started yet), template, audience, and for a scheduled send `sendAtLocal` (`2026-11-20T18:30`) with `timezone` (default `Asia/Kolkata`) and `ifLateMinutes` (default 60). Optional `campaignKey` with `skipPreviousRecipients: true` skips people who already received a campaign with the same key. Members can draft; only owners and admins can start, schedule, pause, resume, cancel or test-send.
2. **Count preview** (`POST .../count-preview`). Mandatory, and valid for 15 minutes; editing the campaign or its audience makes it stale.
3. **Start or schedule** (`POST .../start` or `.../schedule`). Both check, in order: the state, the audience, the send time (schedule), a frozen snapshot, the filter against the current schema, the channel, the count preview, and the confirmation. Above `MARKETING_CONFIRM_THRESHOLD` people (default 5,000) the call answers `confirmation_required` with `details: { count, channel }`; repeat it with `{ "confirm": { "count": ..., "channel": "..." } }` naming the same values.

**One campaign at a time per project.** While a campaign is running or paused, a new start is queued: it becomes `scheduled` and starts by itself as soon as the slot is free. A paused campaign keeps the slot until it is resumed and finishes, or is cancelled.

**When no worker runs at the scheduled time.** The campaign still starts if a worker picks it up within `ifLateMinutes` of its time, plus one minute of grace (so `0` still allows the due minute); later than that it is marked `missed` and is not sent. A scheduled campaign that is due while another one holds the slot also waits, and is missed if the wait outlasts its window. Missed is final: create a new campaign.

**Materialising.** After the start, a worker pages the audience source for ids (1,000 per page) and writes the recipient list; the campaign shows `materializeState` and the `queued` counter. If a worker stops, another continues from the last page. If the source is down the campaign stays running and shows `materializeError` until the source is back; after 5 contract (or unexpected) errors it fails with `stateReason: "materialize_failed"`. Keep `MARKETING_SOURCE_CONCURRENCY` at 2 or more so journeys keep a source slot while a campaign materialises.

## 11. Try it end to end

With the stack running, `scripts/e2e.ts` creates a rule, sends events through `/track`, and checks that one signed webhook arrives and that a person who reaches the goal is not messaged. Setup and variables: README, "End-to-end check". A manual check:

1. Configure a webhook channel pointing at a request-catcher URL (use `MARKETING_WEBHOOK_ALLOW_HOSTS` for a local receiver).
2. Create an active rule with a first step at 10 seconds and set `MARKETING_GRACE_SECONDS=1`, `MARKETING_TICK_MS=1000` in a test environment.
3. Send `add_to_cart` with `item_id=1` for an identified profile (an SDK call, or `POST /track` with a `profileId`; see `scripts/e2e.ts` for a working payload) and watch the request arrive. Send `purchase` with the same `item_id` before the step is due to see it cancelled.
4. Open Marketing, Results to see the counts.

## 12. Operate it

- **Logs**: `docker compose logs -f op-marketing`. `sending paused` means the consumer is behind `MARKETING_MAX_LAG`; nothing is lost, and sending resumes when it catches up.
- **Health**: `GET /marketing/health` on the worker.
- **Scale**: run more replicas of `op-marketing`; they share the consumer group and the work. Sizing, retention, history purge and key revocation are in the README, "Operations".
- **Backups**: the `marketing` schema is in the same Postgres as OpenPanel and is covered by your existing backups.
- **Upgrade OpenPanel**: merge upstream. Only the files in `TOUCHPOINTS.md` can conflict (README, "Upgrading from upstream"). Rebuild both images from the same release.

## 13. Troubleshooting

| Symptom | Likely cause |
|---|---|
| No "Marketing" in the sidebar, or the pages 404 | The dashboard is the stock image, or `MARKETING_URL` / `MARKETING_PROXY_SECRET` are not set on it. |
| Unsubscribe link 404s | The same, or `MARKETING_PUBLIC_URL` is not the dashboard's public origin. |
| Rule is active but nobody is messaged | The event names differ from what your SDK sends; events have no `profileId`; no contact email or device synced; the lag gate is closed; quiet hours or caps hold it back. Check Results (skipped / failed). |
| Steps show `skipped: expired` | The step was more than `MARKETING_MAX_LATENESS` past its scheduled time (an outage, a failing audience source or a long backlog). Intended. |
| Steps show `unreachable:...` or `suppressed` | The audience source says the person cannot be reached on that channel (HTTP source). |
| Source shows failing | Wrong key or secret (401), the API is down, or its answers do not match the contract; run the conformance suite. |
| Everyone is messaged though they reached the goal | A `matchOn` property is missing on the goal event, or the goal event name differs. For a `set` goal, the set does not contain the value the app sends. |
| `401` from the sync API | Wrong or revoked key. After revoking, a replica may accept the old key for up to 5 minutes. |
| `429` from the sync API | Too many failed key attempts from one IP (30 per minute). |
| Email fails | SMTP settings or TLS mode; check the failure reason in Results. |
| Push has no effect | Service account JSON for another Firebase project, or the device token belongs to a different Firebase app. |
| Webhook shows `blocked url` | Not https and the host is not in `MARKETING_WEBHOOK_ALLOW_HOSTS`, or it resolves to a private address. |
| Audience edit answers `audience_in_use` | A scheduled, running or paused campaign uses it (see 9). |
| Start answers `audience_snapshot_stale` | The snapshot audience was edited after its last freeze; freeze it again. |
| Start answers `count_preview_required` | No count preview, or it is older than 15 minutes, or the campaign or audience changed since; preview again. |
| Start answers `channel_not_ready` | SMS and WhatsApp campaigns cannot start in this version. |
| Campaign stays `scheduled` after Start | Another campaign of the project is running or paused; it starts when that one finishes or is cancelled. |
| Campaign shows `missed` | No worker picked it up within `ifLateMinutes` (plus one minute) of its time, or another campaign held the slot that long. |
| Campaign shows `materializeError: source_unavailable` | The audience source is down; it retries every 30 s and continues by itself. |
| Worker will not start | A required variable is missing (the log names it), or `MARKETING_DB_POOL` is below `MARKETING_SEND_CONCURRENCY` + 3, or `MARKETING_LEASE_SECONDS` is not greater than `MARKETING_LOOKUP_WINDOW_MS` / 1000 + 31. |

## 14. Limits worth knowing

- Delivery is at least once per step; webhook receivers must de-duplicate on `idempotency-key`.
- Projects with an active inactivity rule store every identified event (see README, "Event pre-filter trade-off"); plan capacity for that.
- Message text is a template with variables; AI-written messages are not part of this version.
- Campaigns build their recipient list but are not delivered yet; SMS and WhatsApp cannot start; frequency caps, quiet hours and opt-outs are not applied to campaigns yet; a test send is recorded only.
- A queued start's confirmation is the one given when it was queued; the count is not checked again when it starts.
- A paused campaign keeps the project's campaign slot.
- History retention and API-key list/revoke endpoints are not built in; the README has the SQL recipes.
- Full list: the spec's "Known limitations / follow-ups".

## 15. Rules for changing the code

This is a fork. Never edit OpenPanel's existing files for the plugin; see [`../AGENTS.md`](../AGENTS.md) and [`../TOUCHPOINTS.md`](../TOUCHPOINTS.md).
