# Audience API conformance suite

Checks that an implementation of the audience contract (`src/audience/contract.ts`, signing in `src/audience/signing.ts`) behaves the way the marketing plugin needs. Point it at any URL: the owner's backend, the reference service in `examples/audience-api-postgres`, or a third party's.

The suite only works against a database loaded with the **seed contract** below, because it compares answers with known results.

## The seed contract

| File | What |
|---|---|
| `seed/dataset.json` | The dataset: 120 students over 3 universities, 4 courses, 2 semesters, with enrollments (multi-course students), devices and purchases. The authoritative copy. |
| `seed/seed.sql` | The same data as Postgres DDL and inserts into the schema `conformance_demo` (dropped and recreated; nothing else is touched). |
| `seed/expected.json` | What a conformant target answers on that data: counts for named filters, page sequences, explanations, lookup statuses, resolve results, dimension values. |
| `seed/generate.ts` | Builds all three deterministically (no randomness). Expected results come from a small in-memory evaluator, not from SQL. |
| `seed/reference-mapping.json` | The reference service's mapping onto `conformance_demo`. |

Regenerate after changing the generator with `bun conformance/seed/generate.ts`; `seed/generate.test.ts` fails when the committed files and the generator disagree, including the row counts in `seed.sql`.

What the data deliberately contains: suppressed students, students with no phone, no email or an unverified email, no semester, no course, only an inactive or a blank-token device; students with a second course (and one enrolled twice in the same course); purchases that are active without expiry, active and expired, inactive, or active until a far-future date.

Rules the expected results encode:

- **Order.** Member ids ascend **compared as text**, and pages are keyset pages of that order. All dataset ids have four digits, so an implementation that orders a numeric id column numerically produces the same pages.
- **Suppression.** A suppressed student is never an audience member: not counted, not paged, `explain` says `matches: false`. `lookup` still reports them, as `suppressed`. In `sia-backend` terms, suppressed is `NOT users.active`.
- **`not_in`** includes students with no value (NULL semester, no course at all).
- **Multi-valued `course`** matches the primary course or any enrollment, and a student is always one member.
- **`purchase_status`** is `PURCHASED` for an active purchase whose expiry is empty or not past, otherwise `NOT_PURCHASED`.

### Loading it

Postgres, into the reference service's database:

```bash
psql "$DATABASE_URL" -f conformance/seed/seed.sql
```

Into your own schema (the owner's backend, a third party): read `seed/dataset.json` and insert it into your tables, mapping its fields to your columns (`suppressed` to your suppression flag, `semesterId` to your semester column, and so on). The dimension keys the suite filters on are `university`, `course`, `semester`, `signup_date` and `purchase_status`; your `/schema` must declare them (extra dimensions are fine). University, course and semester values are the dataset's numeric ids; declare those dimensions as `number` or `string` and the suite sends the values in the type you declared.

MySQL and other databases: `seed.sql` is plain inserts, but the DDL uses Postgres schemas (`DROP SCHEMA ... CASCADE`), `bigint`/`boolean`/`date` types and a view with `UNION`. Create the tables yourself (a MySQL database in place of the schema, `TINYINT(1)` for booleans) and load `dataset.json`, or strip the schema prefix from `seed.sql`. Make sure your `purchase_status` comparison against today's date and your string collation match the rules above.

## Running it

```bash
export MARKETING_CONFORMANCE_SECRET=...   # prefer this to --secret: arguments land in shell history
bun conformance/cli.ts --base-url https://host/internal/audience --key-id <key id>
```

`--secret <secret>` also works. The secret is never printed. The summary lists each failure and warning by check name; the exit code is 1 if any check failed (2 for a usage error). Run it against a test deployment, never production: it sends invalid and hostile requests, and its expected results only hold on the seed.

From code: `runConformance({ baseUrl, keyId, secret, fetch? })` in `run.ts` returns `{ passed, failed: [{check, detail}], warnings: [{check, detail}] }`. Details carry check names, ids from the dataset and HTTP status codes, never response bodies or contact values.

## What each check proves

Positive checks go through the plugin's own client (`createHttpSource`), so its response validation is exercised too; negative checks send raw signed requests.

| Check | Proves |
|---|---|
| `schema` | `/schema` parses; declares the five dimensions with the right shape (`course` multi-valued, `university` and `course` listable, `signup_date` a date, `purchase_status` a string); does not declare the reserved `id`. |
| `dimension_values` | Value search is case-insensitive and returns the expected values; `limit` is respected. |
| `counts` | Every named filter in `expected.json` counts right: `and`/`or` nesting, `in`, `not_in` with NULLs, `gt`, `lt`, `between`, `exists`, `id` `in`/`not_in`. |
| `count_matches_pages` | `count` equals the number of ids paged out. |
| `paging_no_duplicates` | Small pages never repeat an id and ascend as text. |
| `page_sequences` | Pages at limit 7 are exactly the expected ones, and concatenated they are the sorted id list. |
| `multi_course_once` | A student with two matching courses is counted and paged once. |
| `preview_masked` | `fields: preview` never shows a full first or last name. |
| `explain` | `explain` names each condition in order with the expected matched flag. |
| `lookup_entries` | Exactly one entry per distinct requested id (duplicates and unknown ids included); an empty request answers no entries. |
| `lookup_statuses` | `ok`, `not_found`, `suppressed`, `unreachable` per channel (`email`, `sms`, `whatsapp`, `push`, `none`); `unreachable` carries a reason; `ok` entries carry the right address and `traits.firstName`, and no contact field the channel does not need. |
| `resolve` | Emails match case-insensitively and phones by digits; unmatched inputs are reported; the response holds ids only. |
| `security_no_key`, `security_wrong_key`, `security_tampered_body`, `security_stale_timestamp`, `security_replayed_nonce` | Each answers exactly 401 (spec 5.3: no key, wrong secret or unknown key id, body changed after signing, timestamp 120 s old or ahead, a nonce used twice). |
| `undeclared_dimension` | A filter on a column the schema does not declare is rejected. |
| `limit_page`, `limit_lookup`, `limit_resolve`, `limit_id_values` | A page of 1,001, 501 lookup ids, 201 resolve inputs and an `id` condition of 1,001 values are rejected. |
| `filter_depth` | A filter nested four deep is rejected. |
| `injection` | Quotes, `; DROP`, comment markers, `LIKE` wildcards and unicode in filter values, explain and lookup ids, resolve inputs and value search answer an ordinary result (a count of 0) or a rejection, never a 5xx. |

**Rejections.** The spec says only that these requests fail closed; the reference service and the owner's plan answer 400. The suite accepts any 4xx except 401, 403, 404 and 405 (a signed request to a contract route must reach validation) and warns with `rejection_status` when it is not 400.

## Warnings

Warnings never fail the run.

| Warning | Means |
|---|---|
| `service_level_count` | A `count` took over 2 s. |
| `service_level_page` | A page of 1,000 members took over 2 s. |
| `service_level_lookup` | A lookup of 500 ids took over 1 s. |
| `lookup_reasons` | An `unreachable` reason differs from the reference vocabulary (`no_email`, `unverified_email`, `no_valid_phone`, `no_active_device`). The contract does not pin reason strings yet; the plugin records whatever you send. |
| `rejection_status` | A rejection used a 4xx other than 400. |

The seed is small, so the service-level warnings only catch gross slowness. The real service levels are at the owner's scale; measure them separately on production-sized data.
