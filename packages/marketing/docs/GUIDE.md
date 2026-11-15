# Marketing: setup and integration guide

This guide takes you from nothing to a working marketing. The reference for every environment variable, the operations notes and the upgrade notes are in [`../README.md`](../README.md). This guide does not repeat them.

## 1. What it is

Marketing is an optional add-on for OpenPanel. It is a separate service (`op-marketing`) plus a few dashboard pages. It does not change OpenPanel's own code paths: it reads the same events topic as OpenPanel, with its own Kafka consumer group, and keeps its own tables in the Postgres schema `marketing`.

A **rule** says: *when event A happens for a person, and goal G does not happen within time T, send a message*. A rule has one or more timed **steps**; each step sends one message over one **channel** (email, webhook or Firebase push). Campaigns can also use SMS and WhatsApp through MSG91.

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
| Campaign | A one-off message to an audience over one channel (push, email, webhook, SMS or WhatsApp), started now or at a scheduled time. A worker builds the recipient list and then sends it in batches (section 10). |

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

**Dynamic or snapshot.** A dynamic audience is evaluated each time a campaign using it starts. A snapshot audience is evaluated only when you call `POST .../freeze`, after your edits: the ids are frozen (up to 100,000), and every later edit makes the snapshot stale until you freeze again. Freezing needs the source to answer at that moment; if it is down, the freeze fails and the previous snapshot stays. Saving an audience never waits for the source. A large freeze can outlast the dashboard proxy's request timeout: on a 504 the freeze keeps running in the worker, so poll the audience until `snapshotVersion` equals `version` instead of freezing again.

While a campaign that uses an audience is scheduled, running or paused, the audience is locked (`audience_in_use`): it cannot be edited, frozen or deleted. To change the selection, unschedule or cancel that campaign, or create another audience.

## 10. Campaigns

A campaign sends one message to an audience over one channel. It is drafted, checked and started; its recipient list is built ("materialised") and then delivered by the send engine. Channel credentials, templates and limits are in 10.1 to 10.7; read them before the first campaign.

1. **Draft** (`POST /marketing/campaigns`): name, channel (`push`, `email`, `webhook`, `sms`, `whatsapp`), template (for `sms` and `whatsapp` `{ "templateId": "..." }`, see 10.2), audience, and for a scheduled send `sendAtLocal` (`2026-11-20T18:30`) with `timezone` (default `Asia/Kolkata`) and `ifLateMinutes` (default 60). Optional `campaignKey` with `skipPreviousRecipients: true` skips people who already received a campaign with the same key. Members can draft; only owners and admins can start, schedule, pause, resume, cancel or test-send.
2. **Count preview** (`POST .../count-preview`). Mandatory, and valid for 15 minutes; editing the campaign or its audience makes it stale.
3. **Start or schedule** (`POST .../start` or `.../schedule`). Both check, in order: the state, the audience, the send time (schedule), a frozen snapshot, the filter against the current schema, the channel, the count preview, and the confirmation. Above `MARKETING_CONFIRM_THRESHOLD` people (default 5,000) the call answers `confirmation_required` with `details: { count, channel }`; repeat it with `{ "confirm": { "count": ..., "channel": "..." } }` naming the same values.

**Push campaigns.** A push campaign template is a title (`subject`), the text (`body`), an optional `imageUrl` and an optional `link`. The image must be an `https` URL; the link may be a web address or an app deep link such as `sia://course/12`, but not `javascript:`, `data:`, `file:` or `vbscript:`. Neither takes `{{variables}}`. The app receives the link as `data.link` and decides what to open. Journey push steps are unchanged.

**One campaign at a time per project.** While a campaign is running or paused, a new start is queued: it becomes `scheduled` and starts by itself as soon as the slot is free, unless the wait outlasts `ifLateMinutes`, in which case it is marked `missed`. A paused campaign keeps the slot until it is resumed and finishes, or is cancelled.

**When no worker runs at the scheduled time.** The campaign still starts if a worker picks it up within `ifLateMinutes` of its time, plus one minute of grace (so `0` still allows the due minute); later than that it is marked `missed` and is not sent. A scheduled campaign that is due while another one holds the slot also waits, and is missed if the wait outlasts its window. Missed is final: create a new campaign.

**Materialising.** After the start, a worker pages the audience source for ids (1,000 per page) and writes the recipient list; the campaign shows `materializeState` and the `queued` counter. If a worker stops, another continues from the last page. If the source is down the campaign stays running and shows `materializeError` until the source is back; after 5 contract (or unexpected) errors it fails with `stateReason: "materialize_failed"`. If the project has no `http` source (it was switched to `stored`), a dynamic audience's campaign fails at once with `stateReason: "source_not_http"`; a frozen snapshot is copied without the source. Keep `MARKETING_SOURCE_CONCURRENCY` at 2 or more so journeys keep a source slot while a campaign materialises.

**Sending.** Once materialised, a worker sends in batches: it looks each batch up at the audience source, skips people who are `not_found`, `suppressed`, `unreachable:<reason>`, `opted_out`, without `consent` (when the channel requires it) or `capped`, and fails those whose template variable is missing (`missing_variable`, SMS and WhatsApp only). Rows stay pending, with no skip, while quiet hours (`dispatchError: "quiet_hours"`), a provider backoff (`rate_limited`), an unreachable provider (`channel_unreachable`), the email daily quota (`quota_exhausted`, resumes at local midnight), missing credentials (`channel_not_configured`), rejected credentials (`channel_auth_failed`), a source outage (`source_unavailable`, `source_auth_failed`) or a batch that could not be prepared (`dispatch_error`) hold the campaign; 5 contract errors from the source fail it with `stateReason: "source_error"`. `queued` is the number materialised as pending and never goes down; read progress from `sent`, `failed`, `skipped` and `uncertain`. Each worker runs `MARKETING_CAMPAIGN_CONCURRENCY` send loops (default 2). A test send goes out once; if the worker dies mid-send it ends `failed` with reason `uncertain` and is never retried (10.6).

### 10.1 Channel credentials and settings

A campaign can start only when its channel has a stored credential; `sms`, `whatsapp` and `email` also need a saved `ratePerSecond`, and `email` a `dailyQuota` (the defaults have neither). Other channels start on the default settings. Routes (worker path `/marketing/...`; the dashboard proxy serves the same paths as `/marketing-api/...`, owners and admins only for changes). The Channels tab has a card for each channel's credentials and its sending settings; the routes below are what it calls.

| Route | Body | Answer |
|---|---|---|
| `GET /marketing/channels/{channel}` | none | `{ channel, configured, config }` (secrets masked) |
| `PUT /marketing/channels/{channel}` | `{ config }` | the same; `{channel}` is `email`, `webhook`, `push`, `sms` or `whatsapp` |
| `GET /marketing/channels/{channel}/settings` | none | `{ channel, settings, version, configured, issues }` |
| `PUT /marketing/channels/{channel}/settings` | `{ settings, expectedVersion }` | the same, with the new `version`; a stale `expectedVersion` is `version_conflict` |

Credentials: `sms` is `{ authKey, baseUrl?, defaultCountryCode? }`; `whatsapp` is `{ authKey, integratedNumber, baseUrl?, defaultCountryCode? }`. Before sending, a recipient's phone is reduced to its digits, a ten digit number gets `defaultCountryCode` (one to four digits, default `91`) in front, and a number with fewer than eleven digits is never sent: the recipient fails with `no_phone`. (`baseUrl` is an `https` origin on a `*.msg91.com` host, default `https://control.msg91.com` for SMS and `https://api.msg91.com` for WhatsApp; leave it out unless MSG91 gives you another host. Any other host is rejected on save and at send time unless it is listed in `MARKETING_WEBHOOK_ALLOW_HOSTS`, which is how a local fake is reached). `email`, `push` and `webhook` are as in section 6.

Settings keys (one row per project and channel; `GET` returns the defaults until you save):

| Key | Meaning |
|---|---|
| `concurrency` | Sends in flight for this project and channel (1 to 200; defaults: push 10, email 5, sms 4, whatsapp 4, webhook 10). Per worker process, see 10.6. |
| `ratePerSecond` | Ceiling on recipients per second, shared by all replicas through Redis; `null` for none. Required for `sms`, `whatsapp` and `email`. |
| `quietHours` | `{ enabled, start, end, timezone }`; off by default (`21:00` to `08:00`, `Asia/Kolkata`). `start` and `end` must differ. |
| `requireConsent` | Skip people without consent (10.5). `sms` and `whatsapp` only. |
| `pricePerMessage` | `{ amount, currency }` or `null`; feeds the cost estimate (10.7). |
| `dailyQuota` | Messages per local day, `email` only; required for `email`. |
| `quotaTimezone` | Where a "day" starts for the quota (default `Asia/Kolkata`). |

`issues` lists what still blocks a start: `rate_required` and `quota_required`. Saving `requireConsent` on a channel other than `sms` or `whatsapp`, or `dailyQuota` on a channel other than `email`, is refused with `invalid_settings` (`consent_not_supported`, `quota_not_supported`).

A start (or schedule) answers 409 with `channel_not_configured` (no credential row), `rate_required`, `quota_required`, or, for `sms` and `whatsapp`, `template_not_found`, `template_disabled`, `template_mapping_missing` or `template_channel_mismatch`. After a start was accepted, a campaign whose credential was removed waits as `dispatchError: "channel_not_configured"`. The code `channel_not_ready` is not answered by the worker.

### 10.2 MSG91 (SMS and WhatsApp)

The plugin calls MSG91 with its own credentials and the templates you enter; it never calls sia-backend. It follows the way sia-backend sends today: SMS through the MSG91 flow endpoint, WhatsApp through the bulk template endpoint, both with up to 100 recipients per request, and the auth key in the `authkey` header.

1. **Credentials.** `PUT /marketing/channels/sms` with `{ "authKey": "<your MSG91 auth key>" }`, and `PUT /marketing/channels/whatsapp` with `{ "authKey": "<key>", "integratedNumber": "<digits of your WhatsApp business number>" }`. Use a key made for this service, not the one in sia-backend's configuration (that key sits in a committed file there and should be rotated). Keys are encrypted at rest and never logged; they are replaced by `[redacted]` in stored failure reasons.
2. **Settings.** `PUT .../settings` with a `ratePerSecond` at or below your MSG91 account's limit, and `requireConsent` and `quietHours` as you need them.
3. **A template per message.** `POST /marketing/templates`:

   ```json
   { "channel": "sms", "displayName": "Exam reminder", "category": "service",
     "providerRef": { "flowId": "<MSG91 flow (DLT template) id>", "senderId": "ABCDEF" },
     "approvedText": "Hi ##name##, your exam is on ##date##",
     "variables": [ { "slot": "name", "value": "{{profile.firstName}}" } ] }
   ```

   ```json
   { "channel": "whatsapp", "displayName": "Exam reminder", "category": "service",
     "providerRef": { "templateName": "exam_reminder", "namespace": "<Meta namespace>", "language": "en" },
     "approvedText": "Hi {{1}}, your exam is on {{2}}",
     "variables": [ { "slot": "body_1", "value": "{{profile.firstName}}" },
                    { "slot": "body_2", "value": "{{profile.examDate}}" } ] }
   ```

   - SMS: `flowId` is the MSG91 flow id (letters and digits). The DLT template id, entity and sender are attached to the flow inside MSG91; `senderId` (six capital letters) is optional and sent as `sender`. A `slot` is the variable name the flow uses (letters, digits and underscore, starting with a letter), sent as that key in the request.
   - WhatsApp: `templateName` (lower case, digits, underscore), `namespace`, `language` (`en`, `en_US`) as in Meta's approved template; an optional `integratedNumber` overrides the channel's for this template. A slot is `header_n`, `body_n` or `button_n` with `n` from 1 to 99, in Meta's positional order (`{{1}}` is `body_1`).
   - A value may only contain `{{profile.<trait>}}` placeholders: the traits your audience API returns for the person. A person whose trait is missing or blank is recorded as `missing_variable` and not sent.
   - `category` is `promotional` or `service`; `approvedText` is the approved wording, kept for previews and the audit trail.
   - Errors: `mapping_mismatch` (a slot or value the template cannot take), `channel_immutable` (a template cannot change channel), `version_conflict` (a stale `expectedVersion` on `PUT templates/{id}`).
4. **Versions.** Every edit (`PUT /marketing/templates/{id}`) makes a new version; `GET .../versions/{n}` shows an old one. A campaign pins the version current when it starts, so editing or disabling a template afterwards never changes a running campaign (disabling blocks new starts: `template_disabled`). `POST .../enable` and `.../disable` switch it.
5. **Preview.** `POST /marketing/templates/{id}/preview` with `{ "sample": { "profile": { "firstName": "Asha" } } }` returns the variables and the rendered text without sending anything.
6. **The campaign** uses `"template": { "templateId": "<id>" }`.
7. **First real send.** Make an audience that contains only your own profile (the owner's number), draft a campaign on it and use `POST /marketing/campaigns/{id}/test-send` with your profile id, or start the one-person campaign. Check your phone and the recipient row (`GET .../recipients`) before sending to anyone else. Test sends are limited to 10 per campaign per hour.

**What is not verified against the real service.** The owner's MSG91 access is not available yet, so everything below was built from sia-backend's working calls and tested only against a fake MSG91 server. Check each on the first real send and report differences:

- The per-recipient `results[]` shape of the WhatsApp bulk response. The plugin reads each entry's `to` and a status or error code; if the real response differs, every recipient of a 2xx response without a readable entry is recorded `uncertain` (`msg91 unlisted`), never `sent` by guess, and a success flag without entries marks the whole request sent.
- Whether a 400 or 422 can accept part of a request. The plugin assumes it cannot: it splits a rejected request in halves until the rejected recipients are found, and stops after several single recipients were rejected with none accepted in the group (a bad template then fails fast instead of one request per person). If MSG91 accepts some recipients of a rejected request, those people would be sent again by the split.
- The 100-recipient chunk limit for both endpoints.
- That any 2xx means accepted. A delivery report is not read: `sent` means MSG91 accepted the request, not that the phone received it.

A connection that drops after the request was written, or a 5xx answer, leaves the row `uncertain` (10.4). A 401 or 403 holds the campaign with `dispatchError: "channel_auth_failed"` until the key is fixed. A 429 backs the channel off by `Retry-After` and the rows stay pending.

### 10.3 Email

**No email provider is configured yet.** Email was built and tested only against a fake SMTP server; the owner will choose and set up a provider later, and opt-out handling for campaigns is deferred with it. What exists now: campaign email goes through one pooled SMTP connection set per project and credentials, every message carries the unsubscribe link and `List-Unsubscribe` headers, and anyone who unsubscribed through that link (a row in `marketing.opt_outs`) is skipped as `opted_out`. Bounces, spam complaints and provider webhooks are not read.

Guidance for when it is set up:

- **Provider.** Amazon SES in the Mumbai region, Brevo, Mailgun or SendGrid. Verify your sending domain with SPF, DKIM and a DMARC policy before the first campaign, and warm the volume up over several days.
- **Not the free Gmail SMTP account.** It allows about 500 messages a day, so it cannot carry a 20,000-person campaign (40 days), and Gmail may block bulk sending from it.
- **Settings.** Set `ratePerSecond` to the provider's send rate and `dailyQuota` to its daily limit; both are required for a start. A campaign larger than what is left of today's quota answers `quota_spread_required` (10.4).

### 10.4 Pacing, quiet hours, quotas and what holds a campaign

- **Quiet hours** are a channel setting, with a per-campaign override (`quietHoursOverride` on the campaign). Inside them nothing is sent and nothing is skipped: the rows stay pending and the campaign resumes when the window ends. Quiet hours are off by default.
- **Rate and concurrency.** `ratePerSecond` is a token bucket shared across replicas through Redis; `concurrency` is how many requests run at once (10.6). The engine adds no other delay.
- **Daily quota (email).** When today's quota is used up, the campaign stays running with `dispatchError: "quota_exhausted"` and `dispatchRetryAt` set to the start of the next local day (`quotaTimezone`). On `start` or `schedule`, the gate compares the count with today's remaining quota, not the full quota: a larger campaign answers 409 `quota_spread_required` with `details: { count, remainingToday, daysNeeded }`; repeat the call with `{ "confirm": { ..., "spreadOverDays": true } }` to send over several days.
- **`dispatchError`** is set while the dispatcher is holding a running campaign, and `dispatchRetryAt` says when it tries again; `dispatchRetryAt` only means something while `dispatchError` is set (otherwise the API returns `null`). Values: `source_unavailable` (the audience source is down; retries every 30 s), `source_auth_failed` (retries every 5 minutes), `source_error` (a contract error from the source; the fifth fails the campaign), `channel_auth_failed` (the provider rejected the credential), `channel_unreachable` (no request reached the provider, for example refused connections; the channel backs off), `channel_not_configured` (no credential row), `quota_exhausted`, `quiet_hours` (waits for the window to end), `rate_limited` (the provider answered 429 and the channel backs off), `dispatch_error` (preparing a batch failed unexpectedly; retried after a backoff). A successful source lookup clears only the source values; the others clear once a batch reaches the provider, when the channel's settings or credential change, or on resume. `stateReason` of a failed campaign: `source_error` (five contract errors from the source), `source_not_http` (the project no longer has an `http` source), `template_not_found` (the pinned template version has gone missing), `invalid_frequency_cap` (the stored cap no longer parses), `materialize_failed`, `materialize_restart_after_sending` (materialising would have restarted after rows were sent), `template_unavailable` (a scheduled campaign whose template is no longer usable when its time comes) and, for a `missed` campaign, `late`.
- **Pause and cancel.** A batch whose rows are already marked `sending` when a cancel or pause lands is still delivered; everything not yet marked stops within one dispatch cycle. Cancel records the rest as `skipped: cancelled`.
- **A scheduled campaign that keeps failing to start** (for example its audience cannot be checked) is retried on every scheduler tick, and each failure is logged; it never blocks the other scheduled campaigns. It is marked `missed` once its window passes.

### 10.5 Consent, frequency cap and skip reasons

- **Consent.** With `requireConsent` on for `whatsapp`, a person is sent only when the audience API returns `consent.whatsapp: true`; for `sms` the check applies to `promotional` templates and needs `consent.sms_promotional: true`. Anyone else is skipped as `consent`. Off by default; `service` SMS templates ignore it.
- **Frequency cap.** `caps` in the project settings (`{ max, periodSeconds, scope }`, section 8) and the campaign's own `frequencyCap` count sends from the shared send ledger: journey steps and campaigns together. `scope: "channel"` (default) counts only the same channel; `"all"` counts every channel. A capped person is skipped as `capped`. The ledger keeps 400 days of sends.
- **Skip and failure reasons** (`GET /marketing/campaigns/{id}/skip-reasons` counts them; `GET .../recipients?status=&cursor=&limit=` lists rows): `not_found`, `suppressed`, `unreachable:<reason>` (from the audience source), `opted_out`, `consent`, `capped`, `cancelled`, `already_received`, `missing_variable`, `render_failed`, `max_attempts` (retried too often), `lease_expired` (a worker died mid-send), `operator_retry`, `rate_limited`, `channel_error`, `failed` and `cancelled` (rows left unsent when the campaign failed or was cancelled), `unreachable:no_live_token` (every device token is known dead), `no_phone`, `no email`, `invalid email`, `invalid unsubscribe url`, `no device tokens`, `blocked url` (a webhook host not allowed), `timeout`, `network`, `network error`, `exception`, `deadline` and `breaker` (the batch ran out of time, or too many single rejections stopped it, before this row was tried), `msg91 failed`, `msg91 conflicting` and `msg91 unlisted` (a partial WhatsApp answer that contradicts itself or leaves the row out; the row is `uncertain`), and provider codes `msg91 <code>`, `fcm <code>`, `smtp <code>`, `http <status>`.

### 10.6 How delivery behaves

- **At most once.** A row is marked `sending` before the provider call and `sent` after. If the worker dies, the connection drops after the request was written, or the provider answers 5xx, nobody knows whether the message went out, so the row ends **`uncertain`**: it is shown and counted, never re-sent by itself. It is the one place the engine prefers a lost message over a duplicate.
- **Retrying uncertain rows.** `POST /marketing/campaigns/{id}/retry-uncertain` (owners and admins) puts every `uncertain` row of that campaign back to pending, clears their send-ledger rows and answers `{ retried, campaign }`; a completed campaign reopens. It answers 409 `invalid_transition` for a campaign that is not running, paused or completed, and `another_campaign_active` when reopening a completed one while the project already has an active campaign. This is the one deliberate re-send: check with the provider (or the recipients' phones) first, because some of those people may already have received the message.
- **Counters.** `queued` is the number materialised as pending and never goes down; read progress from `sent`, `failed`, `skipped` and `uncertain`.
- **Frequency caps can be briefly exceeded.** A capped batch marks its rows in chunks of 100 people, each chunk under a lock per person; a campaign without a cap does not take that lock. A journey step or another campaign sending to the same person at the same moment may therefore push them one message over the cap.
- **Concurrency is per worker process.** The limit that keeps one project's channel to `concurrency` requests at once lives in each worker process, not across replicas. With N replicas the real parallelism is up to N times `concurrency`; lower `concurrency` accordingly. `ratePerSecond` is shared across replicas.
- **Test sends** (`POST .../test-send`) go through the same lookup, consent and opt-out checks as a real send, so an opted-out or no-consent person is skipped; they ignore quiet hours, frequency caps and the quota, write no ledger row, and are skipped for a `cancelled` or `failed` campaign. `GET .../test-sends` lists them with `status` `pending`, `sending`, `sent`, `failed` or `skipped` and a `reason`: the campaign's state (skipped), `template_not_found` or `template_disabled` (skipped), a skip reason from 10.5 (skipped), `channel_not_configured`, `source_not_http`, `source_unavailable`, `source_auth_failed`, `rate_limited` (no send slot within the time allowed), `missing_variable` or `render_failed`, `uncertain` (the worker died mid-send), or the provider's reason.
- **Push** is sent per recipient over FCM HTTP v1 with pooled connections, because each body is personalised. Against a fake FCM with 150 ms latency and 600 tokens per second, 20,000 recipients took 311 s (section 14).

### 10.7 Cost and time estimate

`POST /marketing/campaigns/{id}/estimate` returns `{ count, channel, ratePerSecond, estimatedSeconds, cost, quota, issues }` from the count preview: the time at the configured rate, the cost when `pricePerMessage` is set (WhatsApp pricing depends on the category and is yours to enter), and for email the daily quota, what was used today and the days needed.

### 10.8 Big tests

The crash tests run with 3,000 recipients for the replica test and 1,000 for the cancel test. Set `MARKETING_BIG_TESTS=1` to run them at 20,000 and 5,000 recipients (`src/campaign/dispatch.crash.test.ts`; it needs a few minutes and a `*_test` database).

### 10.9 Campaigns step by step

What an operator does in the dashboard, with the wording of its screens. The Guide tab says the same in short.

1. **Channels tab.** Connect the audience source (HTTP API: base URL, key id, secret; press Save, then Test connection). Save the channel's credentials, then its Sending settings (concurrency, rate per second, quiet hours, price). SMS and WhatsApp need a rate per second. Email is built, but its provider configuration is not set up yet, so use SMS or push.
2. **Templates tab** (SMS and WhatsApp). Add template: name, category, the provider reference (flow ID for SMS), approved text and variables. Enable it; only enabled templates appear in a campaign.
3. **Audiences tab.** New audience: add conditions under "Who is in", hand-picked students and exclusions as needed, Save, then Count and Preview. A snapshot audience is frozen with "Freeze now".
4. **Campaigns tab.** New campaign: name, channel, audience, template or message, when to send, quiet hours and limit per student. Save.
5. **Check and send.** Count students (valid 15 minutes, and only while the campaign and audience are unchanged), read the estimate, Send test to one student id. Then Start now (or Schedule). It always asks you to confirm the counted number and channel; the server checks it again, and a changed count asks you to count again.
6. **Watch it.** The detail view shows To send, Sent, Failed, Skipped and Uncertain, why some were not sent, and the recipients. A waiting campaign says why in one line and continues by itself.

Facts to know:

- One campaign per project runs at a time; others wait their turn. A paused campaign keeps the slot.
- A draft cannot be cancelled, only edited or deleted. Cancel applies to a scheduled or started campaign.
- An audience used by a campaign that is scheduled, sending or paused cannot be changed or deleted; a draft does not lock it.
- Test sends are queued, final (never retried) and limited to 10 per campaign per hour.
- Uncertain means the provider may or may not have received the message; Retry uncertain can send a duplicate.
- The limit per student counts every message that student got on that channel from any campaign or journey (all channels if the project's limit is set that way).
- Quiet hours for a campaign: "Use the channel's quiet hours" inherits the setting (`quietHoursOverride` is `null` in the API); "No quiet hours" turns them off for this campaign (`{ "enabled": false }`).
- A push `link` reaches the app as `data.link`; the mobile app has to read it.
- Only owners and admins start, schedule, pause, resume, cancel, delete or test; members draft and look.

## 11. Try it end to end

With the stack running, `scripts/e2e.ts` creates a rule, sends events through `/track`, and checks that one signed webhook arrives and that a person who reaches the goal is not messaged. Setup and variables: README, "End-to-end check". A manual check:

1. Configure a webhook channel pointing at a request-catcher URL (use `MARKETING_WEBHOOK_ALLOW_HOSTS` for a local receiver).
2. Create an active rule with a first step at 10 seconds and set `MARKETING_GRACE_SECONDS=1`, `MARKETING_TICK_MS=1000` in a test environment.
3. Send `add_to_cart` with `item_id=1` for an identified profile (an SDK call, or `POST /track` with a `profileId`; see `scripts/e2e.ts` for a working payload) and watch the request arrive. Send `purchase` with the same `item_id` before the step is due to see it cancelled.
4. Open Marketing, Results to see the counts.

### Trying it locally

Without real accounts, `scripts/dev-stack.ts` stands in for the audience API (the reference service over the demo schema `reference_demo`, 50 students) and for MSG91 (a fake that only counts what it receives). It sends nothing real. There is no fake push service yet, so try SMS.

```bash
cd packages/marketing
bun scripts/dev-stack.ts    # needs DATABASE_URL; prints the values to enter and waits for Ctrl+C
```

It drops and recreates the schema `reference_demo`, so it refuses a `DATABASE_URL` whose host is not `localhost`, `127.0.0.1` or `[::1]`. To use another database on purpose, set `DEV_STACK_ALLOW_REMOTE_DATABASE=1`.

Start the worker with `MARKETING_WEBHOOK_ALLOW_HOSTS=127.0.0.1` (the fake MSG91 host; plain http is refused for any other host) and the same `MARKETING_PROXY_SECRET` as `apps/start/.env.local`. Then enter what the script prints: audience source base URL, key id and secret on the Channels tab, and for SMS any auth key with the fake MSG91 base URL (its port changes on each run). Try the audience "Semester is 6": 20 students.

The browser check `apps/start/e2e/marketing-campaigns.spec.ts` walks the whole path as owner, member and outsider. It is skipped unless `MARKETING_E2E=1`:

```bash
cd apps/start
MARKETING_E2E=1 MARKETING_E2E_MSG91_URL=<fake MSG91 base URL from dev-stack> bunx playwright test e2e/marketing-campaigns.spec.ts
```

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
| Start answers `channel_not_configured`, `rate_required`, `quota_required` or a `template_*` code | The channel has no credential row, no `ratePerSecond` (SMS, WhatsApp, email) or `dailyQuota` (email), or the SMS or WhatsApp template is missing, disabled, unmapped or for another channel (10.1). |
| Start answers `quota_spread_required` | The email campaign is larger than today's remaining quota; confirm with `spreadOverDays: true` (10.4). |
| Campaign running but nothing sends, `dispatchError` set | See the values in 10.4; the campaign retries by itself at `dispatchRetryAt`. |
| Rows `uncertain` | The provider may or may not have the message (10.6); retry them only after checking. |
| Campaign stays `scheduled` after Start | Another campaign of the project is running or paused; it starts when that one finishes or is cancelled. |
| Campaign shows `missed` | No worker picked it up within `ifLateMinutes` (plus one minute) of its time, or another campaign held the slot that long. |
| Campaign shows `materializeError: source_unavailable` | The audience source is down; it retries every 30 s and continues by itself. |
| Worker will not start | A required variable is missing (the log names it), or `MARKETING_DB_POOL` is below `MARKETING_SEND_CONCURRENCY` + `MARKETING_CAMPAIGN_CONCURRENCY` + 3 (new: upgrades with a pool of 13 or 14 must raise it), or `MARKETING_LEASE_SECONDS` is not greater than `MARKETING_LOOKUP_WINDOW_MS` / 1000 + 76 (raised from + 31: a lease of 34 to 78 s that booted before must be raised). |

## 14. Limits worth knowing

- Delivery is at least once per step; webhook receivers must de-duplicate on `idempotency-key`.
- Projects with an active inactivity rule store every identified event (see README, "Event pre-filter trade-off"); plan capacity for that.
- Message text is a template with variables; AI-written messages are not part of this version.
- Campaign delivery is at most once: a row that may have reached the provider is `uncertain` and re-sent only by an operator (10.6).
- MSG91 was never called for real: the WhatsApp per-recipient response shape, whether a rejected request can be partly accepted and the 100-recipient limit are unverified (10.2). `sent` means the provider accepted the request, not that it was delivered.
- No email provider is configured yet; opt-out handling for campaigns beyond the unsubscribe link is deferred (10.3).
- Frequency caps can be briefly exceeded and `concurrency` is per worker process (10.6).
- A queued start's confirmation is the one given when it was queued; the count is not checked again when it starts.
- A paused campaign keeps the project's campaign slot.
- History retention and API-key list/revoke endpoints are not built in; the README has the SQL recipes.
- Full list: the spec's "Known limitations / follow-ups".

### Measured performance

Push is sent per recipient, so the `fcm` row below is the evidence for the 20,000-person case. Measured on 2026-11-14 with `bun scripts/load-campaign.ts --mode <mode>` (20,000 recipients, 2 dispatch loops, the real dispatch lane against a fake audience source and a fake provider). Machine: developer laptop, Windows 11, 4-core Intel i5-1135G7, 15.7 GB RAM, Postgres and Redis on the same machine. Re-measure on the target host before relying on these numbers.

| Mode | Result | Target |
|---|---|---|
| `noop` (no-op adapter, instant source) | 20,000 sent in 24.7 s, 808.7 sends/s, 0 duplicates, 0 missing | 1,000 sends/s: not met on this laptop |
| `isolation` (200 due journey steps, 3 rounds idle then 3 rounds during the campaign, journey tick 100 ms; run 2026-11-14) | idle median 1,185 ms / p95 2,769 ms; during median 1,803 ms / p95 3,092 ms (1.52x); campaign 715.7 sends/s | during median at most 2x idle: met |
| `slow-api` (2 s per lookup) | finished in 66.8 s, 0 duplicates, 0 missing, 0 uncertain | finishes, no duplicates: met |
| `fcm` (150 ms latency, 600 tokens/s, one token each) | finished in 311.0 s, 64.3 sends/s, 0 duplicates, 0 missing | within 600 s: met |

Journey latency is measured from `due_at` to `sent_at` over 600 steps per phase with the journey ticker running every 100 ms. It is dominated by the time to send a 200-step tick (10 concurrent sends), not by tick waiting. The other rows are from the first run of 2026-11-14.

## 15. Rules for changing the code

This is a fork. Never edit OpenPanel's existing files for the plugin; see [`../AGENTS.md`](../AGENTS.md) and [`../TOUCHPOINTS.md`](../TOUCHPOINTS.md).
