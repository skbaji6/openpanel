# Audience API contract

This is what an adopter implements so the marketing plugin can select people (audiences), count them, page through them and look up how to reach them, without ever holding the adopter's student records. The plugin is always the client; you run the server. The types are in `src/audience/contract.ts` (zod), the signing code in `src/audience/signing.ts`, a runnable server in `examples/audience-api-postgres/` and a test suite in `conformance/`. If this page and the code disagree, the code wins; please report it.

All bodies are JSON (`Content-Type: application/json` on POST). All paths below are relative to the base URL you register in the plugin (for example `https://api.example.internal/internal/audience`), and that base path is part of what is signed.

## The seven calls

| Call | Purpose |
|---|---|
| `GET /schema` | The filterable dimensions. |
| `GET /dimensions/{key}/values?q=&limit=` | Values for dropdowns and search. |
| `POST /audience/count` | How many people match a filter. |
| `POST /audience/members` | One keyset page of matching ids. |
| `POST /audience/explain` | Why one person is in or out. |
| `POST /members/lookup` | Contact details for up to 500 ids, for sending. |
| `POST /members/resolve` | Turn pasted emails or phone numbers into ids. |

### 1. `GET /schema`

```json
{
  "dimensions": [
    { "key": "university", "label": "University", "type": "number", "multiValued": false, "valuesListable": true },
    { "key": "course", "label": "Course", "type": "number", "multiValued": true, "valuesListable": true },
    { "key": "signup_date", "label": "Signup date", "type": "date", "multiValued": false, "valuesListable": false }
  ]
}
```

`type` is one of `string`, `number`, `date`, `boolean`. The reserved key `id` is built in (see the filter tree) and must not be declared. The plugin only ever sends dimensions declared here; the dashboard builds its audience builder from this list, so the plugin has no vocabulary of its own.

### 2. `GET /dimensions/{key}/values?q=&limit=`

Only for dimensions with `valuesListable: true`. `q` is a case-insensitive search text (may be empty), `limit` the most items wanted. The response is an object with a `values` array (a bare array is rejected as a protocol error):

```json
{ "values": [ { "value": "12", "label": "Biology" }, { "value": "14", "label": "Biotechnology" } ] }
```

`value` is a string; `label` is what people see. The query string is part of the signed path (see below).

### 3. `POST /audience/count`

```json
{ "filter": { "dimension": "semester", "op": "eq", "values": [3] } }
```

Response: `{ "count": 1842 }`. `approximate: true` may be added when the number is an estimate.

### 4. `POST /audience/members`

```json
{ "filter": { "dimension": "semester", "op": "eq", "values": [3] }, "cursor": "MDAyNA", "limit": 1000, "fields": "preview" }
```

`limit` is 1 to 1,000. `fields` is `id` (ids only) or `preview` (id plus a masked `displayName`, never a full name). `cursor` is opaque, absent on the first page, and is the previous response's `nextCursor`. Response:

```json
{ "members": [ { "id": "0024", "displayName": "A. K." } ], "nextCursor": "MDAyNA" }
```

`nextCursor` is always present and is `null` on the last page. A person is always one member, however many rows they span (see "multi-valued dimensions").

### 5. `POST /audience/explain`

```json
{ "filter": { "dimension": "semester", "op": "eq", "values": [3] }, "id": "0024" }
```

```json
{ "id": "0024", "matches": true, "conditions": [ { "dimension": "semester", "op": "eq", "matched": true } ] }
```

One entry per condition, in the filter's order. A person who is suppressed or otherwise not an audience member answers `matches: false`.

### 6. `POST /members/lookup`

Called only by the send engine, for ids it is about to message.

```json
{ "ids": ["0024", "0025", "9999"], "channel": "email" }
```

`channel` is `push`, `whatsapp`, `sms`, `email` or `none` (a webhook step needs traits only). At most 500 ids. The response is **an object with an `entries` array**, exactly one entry per distinct requested id, duplicates collapsed, unknown ids included:

```json
{
  "entries": [
    { "id": "0024", "status": "ok", "email": "student@example.com", "traits": { "firstName": "Ada" } },
    { "id": "0025", "status": "unreachable", "reason": "no_email" },
    { "id": "9999", "status": "not_found" }
  ]
}
```

Entry fields: `id`; `status` (`ok`, `not_found`, `suppressed`, `unreachable`); `reason` (for `unreachable`); `email`; `phone` (digits, international format such as `91XXXXXXXXXX`, only for `sms` and `whatsapp`); `devices` (`[{ "token", "platform" }]`, only for `push`); `traits` (flat `string | number | boolean` values templates use, for example `firstName`); `consent` (`{ "whatsapp"?, "sms_promotional"? }`, optional). Return only the contact field the channel needs.

### 7. `POST /members/resolve`

```json
{ "inputs": ["Ada@Example.com", "+91 98765 43210"] }
```

```json
{ "matches": [ { "input": "Ada@Example.com", "id": "0024" } ], "unmatched": ["+91 98765 43210"] }
```

At most 200 inputs. Ids only: no contact data comes back. Emails match case-insensitively, phones by digits.

## The filter tree

A filter is either a **condition** or a **group**:

```json
{ "op": "and", "children": [
    { "dimension": "university", "op": "in", "values": [1, 2] },
    { "op": "or", "children": [
        { "dimension": "semester", "op": "not_in", "values": [7, 8] },
        { "dimension": "signup_date", "op": "between", "values": ["2026-01-01", "2026-06-30"] }
    ] }
] }
```

- Condition: `{ dimension, op, values }` with `op` one of `eq`, `in`, `not_in`, `gt`, `lt`, `between` (two values), `exists`; `values` are strings, numbers or booleans.
- Group: `{ op: "and" | "or", children: [...] }` with at least one child.
- The reserved dimension `id` supports `in` and `not_in` only, with at most 1,000 values; longer id lists are handled by the plugin.
- Filter values are data. Build parameterised queries; never splice them into SQL.

## Limits

| Limit | Value |
|---|---|
| `members` page `limit` | 1,000 |
| `lookup` ids | 500 |
| `resolve` inputs | 200 |
| `id` condition values | 1,000 |
| Filter depth | 3 |
| Filter string value | 512 characters |
| Request and response body | 8 MiB |

Depth rule: every group counts 1 and a lone condition counts 1. A single condition is depth 1; a group of conditions is 2; a group in a group of conditions is 3. Three nested groups plus a leaf is 4 and is rejected.

The 512-character string limit is enforced by the plugin and the reference service; a server may accept more, but clients never send more.

Anything over a limit is a `400` with a fixed message that does not echo the input.

## Signing

Every request carries four headers:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <keyId>.<secret>` |
| `X-Timestamp` | Unix seconds |
| `X-Nonce` | A fresh random string per request (the plugin uses 32 hex characters) |
| `X-Signature` | Lower-case hex HMAC-SHA256, keyed with the secret, over the canonical string |

The canonical string is five lines joined by `\n` (no trailing newline):

```
METHOD
PATH
TIMESTAMP
NONCE
SHA256_HEX_OF_BODY
```

- `METHOD` is upper case.
- `PATH` is the request path **exactly as sent**, including any base-path prefix and, for the dimension-values call, the query string (`?q=...&limit=...`). It is not the full URL: no scheme or host. The plugin signs the URL-normalised form, what a WHATWG `URL` serialises as `pathname + search` (for example `q=St.%20Mary%27s`: the apostrophe goes out as `%27`). The rule for a server: verify against the path and query string **as received**, byte for byte, before any decoding; never re-encode or decode them first.
- `SHA256_HEX_OF_BODY` is the hex SHA-256 of the raw body bytes; for `GET` the body is empty, so it is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### Worked example

Fixed fake values, never real credentials: key id `demo-key`, secret `demo-secret-not-real`, timestamp `1700000000`, nonce `00112233445566778899aabbccddeeff`, base path `/internal/audience`.

A `POST` of count:

```
body      {"filter":{"dimension":"semester","op":"eq","values":[3]}}
body hash b88862a48c508301ba6a31fd96f5f024991c6d2bfb2e5445e68c6c941833e971
canonical POST
          /internal/audience/audience/count
          1700000000
          00112233445566778899aabbccddeeff
          b88862a48c508301ba6a31fd96f5f024991c6d2bfb2e5445e68c6c941833e971
X-Signature 4ab4d9c7515e8e386b8337a485bc99d14b16d3f1a2094bf42bb022a7323fb9ff
```

A `GET` of dimension values, query string included in the signed path:

```
canonical GET
          /internal/audience/dimensions/course/values?q=bio&limit=20
          1700000000
          00112233445566778899aabbccddeeff
          e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
X-Signature 977cd346515692307dad7046985a16c45796df70694f5ab1237a7c325012ea88
```

(In both, the five canonical lines are separated by single newlines.) Reproduce it with the plugin's own code:

```ts
import { signRequest } from './src/audience/signing';
console.log(signRequest({
  method: 'POST', path: '/internal/audience/audience/count',
  body: '{"filter":{"dimension":"semester","op":"eq","values":[3]}}',
  keyId: 'demo-key', secret: 'demo-secret-not-real',
  timestamp: 1700000000, nonce: '00112233445566778899aabbccddeeff',
}));
```

### Server-side verification

Reject, always with `401 {"error":"unauthorized"}` and no detail, and run nothing else, when: any header is missing; the key id is unknown or the secret does not match; the signature does not match (compare in constant time); the timestamp is more than 60 seconds from your clock; or the nonce was already seen within the last 120 seconds. Verify the signature over the raw body bytes before parsing. Keep the check in front of every route and deny by default: with no key configured every request is a 401.

## Errors and statuses

| Status | Meaning |
|---|---|
| `2xx` | Success. Redirects are never followed by the plugin. |
| `401` | Authentication failed (above). The plugin never retries a 401 or 403 and marks the source as failing. |
| `400` | Validation: bad JSON, unknown dimension, unknown operator, a limit exceeded, depth over 3. Body `{"error":"..."}` with a fixed message. |
| `413` | Body over 8 MiB (the reference service). |
| `429`, `5xx` | Retried by the plugin (below). Send `Retry-After` on 429 and 503 when you can. |

The conformance suite accepts any 4xx except 401, 403, 404 and 405 for a rejected request and warns when it is not 400. A signed request to a contract route that answers 404 or 405 means the route is not implemented.

### Lookup statuses

| `status` | Means | What the plugin does |
|---|---|---|
| `ok` | Reachable; the channel's address is present. | Sends. |
| `not_found` | No such id. | Step recorded as skipped, `not_found`. |
| `suppressed` | A person who must not be messaged (for example a withdrawn student). | Skipped, `suppressed`. |
| `unreachable` | Exists, but cannot be reached on this channel. | Skipped, `unreachable:<reason>`. |

A missing entry is treated as `not_found`.

The reasons the reference service and the conformance suite use, per channel:

| `reason` | Channel | Means |
|---|---|---|
| `no_email` | `email` | No email address stored. |
| `unverified_email` | `email` | An address exists but is not verified. |
| `no_valid_phone` | `sms`, `whatsapp` | No phone number of 8 to 15 digits. |
| `no_active_device` | `push` | No active device with a token. |

The contract does not enforce reason strings. The plugin records a reason only if it matches `/^[a-z0-9_.-]{1,64}$/` and otherwise stores `unknown`, so a free-text reason never reaches its database. The suite warns (`lookup_reasons`) when your reason differs from the list above. The contract reserves `suppressed` and a consent-style unreachable reason (for example `opted_out`) for opt-out handling; the plugin acts on `consent` for campaigns when the channel's `requireConsent` setting is on (`consent.whatsapp` for WhatsApp, `consent.sms_promotional` for promotional SMS; otherwise the person is skipped as `consent`) and ignores it when the setting is off, see `CUTOVER_BACKEND_JOURNEYS.md`.

## Semantics that tests rely on

- **Canonical id order.** Ids are compared as text, ascending (`id::text` if your column is numeric). `members` pages are keyset pages of that order: the next page is the ids greater than the cursor's id. Ids with the same number of digits sort the same either way; if yours vary in length, text order is the contract.
- **A student is one member.** For multi-valued dimensions (a student with two courses) use `EXISTS`, not a join, so counts, pages and explanations all speak of distinct students. `count` must equal the number of ids paged out.
- **`not_in` includes people with no value.** A student with a NULL semester, or no course at all, matches `semester not_in [3]` and `course not_in [12]`. (SQL's `NOT IN` with NULL would drop them; do not.)
- **Suppressed people are never audience members.** Not counted, not paged, `explain` says `matches: false`. `lookup` still reports them, as `suppressed`.
- **Consistency.** A member who changes during a long paging run may or may not be included.

## Service levels (recommended, at your production scale)

| Call | Target |
|---|---|
| `count` | under 2 s |
| `members` page of 1,000 | under 2 s |
| `lookup` of 500 ids | under 1 s |

The conformance suite reports a miss as a warning (`service_level_count`, `service_level_page`, `service_level_lookup`), never a failure.

What the plugin does on its side:

| | |
|---|---|
| Timeouts | 5 s for `count`, 10 s for every other call |
| Attempts | 3 (2 retries) on network errors, timeouts, 429 and 5xx; jittered exponential backoff from 200 ms, capped at 30 s, honouring `Retry-After`; 401 and 403 are never retried |
| Response cap | 8 MiB; a larger response is a protocol error |
| Redirects | Never followed (a redirect answer is an error) |
| Concurrency | At most `MARKETING_SOURCE_CONCURRENCY` calls in flight (default 4), shared across all worker replicas |
| Circuit breaker | A run of failures opens it; journey steps stay pending and nothing is marked failed because the source was down |

## Personal data rules

- The plugin never stores contact data it receives: no email, phone, device token, name or rendered body. It stores ids, a status and a reason per send, and timestamps. Contact fields live in memory for one batch.
- Dead push tokens are stored only as keyed hashes, purged after 90 days.
- Reasons are reduced to `/^[a-z0-9_.-]{1,64}$/`; adapter failure texts have the recipient's address, phone and tokens redacted before they are recorded or logged.
- Phone numbers or emails an operator pastes for `resolve` travel only to that call and are not logged or stored; `resolve` answers ids only.
- `preview` returns masked names only. Your server must never return a column the contract does not name (no password hashes, no unlisted fields): build responses from an allow-listed object, not the entity.
- Never log request bodies or contact values on your side either; log key id, route and counts.

## Securing it (checklist for the adopter)

1. HTTPS only. The endpoints are never published through a public site or CDN, and have no CORS.
2. IP allow-list at your proxy: only the marketing worker's address.
3. A dedicated machine credential, not a user or staff token. Deny by default: no key configured, or a wrong one, is a 401 and nothing runs. If your framework has an authentication interceptor, exclude the audience path from it only so that this check applies.
4. Two keys valid at once, so you can rotate without downtime: add the new key, move the plugin to it, remove the old one. Keys live in environment variables or a secret store, never in git.
5. 60-second timestamp window and a nonce replay cache that remembers nonces for 120 seconds. An in-memory cache is single-instance only: with more than one replica of your API use a shared store (Redis) or a replayed request that lands on another replica is accepted.
6. A read-only database role for the audience code, with access only to the tables needed.
7. Parameterised queries only; a body size limit; a rate limit; responses built from an allow-listed DTO; `Cache-Control: no-store`.
8. Run the conformance suite against a test deployment before go-live and after every change.

## Conformance suite

`conformance/` is a CLI that checks a target against the contract on a known dataset (the "seed contract": `conformance/seed/dataset.json`, `seed.sql`, `expected.json`). Load the seed into a **test** database (never production: the suite sends hostile requests and its expected results only hold on the seed), then:

```bash
export MARKETING_CONFORMANCE_SECRET=...   # preferred over --secret, which lands in shell history
bun conformance/cli.ts --base-url https://host/internal/audience --key-id <key id>
```

The secret is never printed. The summary lists each failure and warning by check name; the exit code is 1 when a check failed and 2 for a usage error. It covers the schema, dimension values, counts of named filters, paging, multi-valued dimensions, masked previews, explain, lookup statuses per channel, resolve, five negative authentication cases (no key, wrong key, tampered body, stale timestamp, replayed nonce, each exactly 401), limits, depth, undeclared dimensions and injection strings. The full table of checks and how to load the seed into your own schema is in `conformance/README.md`. The reference service in `examples/audience-api-postgres/` passes it.
