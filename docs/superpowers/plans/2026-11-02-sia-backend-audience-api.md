# sia-backend Audience API (Track B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the seven read-only, signed `/internal/audience/**` endpoints to `sia-backend` so the marketing plugin can resolve audiences and contact details, and switch the backend's own journeys off behind a flag.

**Architecture:** New classes under `com.mna.siabackend.audience` (properties, request-signature filter, filter-tree compiler, repository over a dedicated read-only datasource, controller with allow-listed DTOs). The route is excluded from the user-JWT interceptor and guarded by its own deny-by-default filter. Acceptance is the Phase 1 conformance suite run against a locally started `sia-backend` loaded with the conformance dataset.

**Tech Stack:** Java 17, Spring Boot 3.3.0, Spring MVC, JPA native queries (existing convention) and `NamedParameterJdbcTemplate` for the audience datasource, Flyway (schema `sia_books`), JUnit 5 + Mockito, H2 in PostgreSQL mode for unit tests, Postgres for acceptance.

**Spec:** `docs/superpowers/specs/2026-10-28-marketing-platform-design.md` sections 5.2, 5.3, 5.4 (in the OpenPanel repo `C:\Repos\openpanel\.worktrees\nudge`). The contract JSON shapes are defined by the marketing package `packages/marketing/src/audience/contract.ts` (Phase 1 Task 5) and documented in `packages/marketing/docs/AUDIENCE_CONTRACT.md` (Phase 1 Task 16). Read both before Task 3.

## Global Constraints

- **Repository.** `C:\Repos\sia-backend`. Work in a new git worktree `C:\Repos\sia-backend\.worktrees\audience-api` on a new branch `feat/marketing-audience-api` cut from `dev`. Never push, never add remotes, never rewrite history, never touch the existing worktree `.worktrees/java25-springboot41-migration`.
- **Existing code.** New classes only, except these allowed edits to existing files: `config/WebConfig.java` (one added `excludePathPatterns("/internal/audience/**")`), `service/NotificationJourneyService.java` and the scheduler entry that triggers journeys (a minimal early return behind a flag), `application.yml` (new `sia.audience.*` and `sia.notifications.journeys.enabled` keys, defaults safe), and a new Flyway migration file. Anything else: stop and ask. No formatter or codemod over existing files. No dependency additions to `pom.xml` unless unavoidable, then stop and ask.
- **Conventions.** The repo has no AGENTS.md; read two neighbouring controllers, services and repositories first and match their style (Lombok, constructor injection, `ResponseDTO` is NOT used here: audience endpoints return the contract's plain JSON). Tests live under `src/test/java/com/mna/siabackend/audience/`.
- **Secrets.** Keys and the read-only DB credentials come from environment variables (`SIA_AUDIENCE_KEYS`, `SIA_AUDIENCE_DB_URL`, `SIA_AUDIENCE_DB_USERNAME`, `SIA_AUDIENCE_DB_PASSWORD`), never from a committed file. Never print or log secrets.
- **Security (spec 5.3).** Deny by default: no configured key or any failed check is 401 and no handler runs. Bearer `<keyId>.<secret>` plus `X-Timestamp`, `X-Nonce`, `X-Signature` = hex HMAC-SHA256 over `${METHOD}\n${path}\n${timestamp}\n${nonce}\n${sha256hex(body)}` keyed by the secret; timestamp window 60 seconds (seconds since epoch); nonce replay rejected (cache TTL 120 s); two keys valid at once; constant-time comparison; maximum request body 1 MiB; maximum page 1,000; lookup at most 500 ids; resolve at most 200 inputs; filter depth at most 3; `id` condition at most 1,000 values. Responses are built from allow-listed DTOs, never entities; never a password hash or any column not in the contract. Logs hold key id, route, status and counts only, never bodies or contact values.
- **Audience semantics.** Base predicate `u.active = TRUE`. `purchase_status` is `PURCHASED` (exists a `purchases` row with `is_active = true` and (`expiry_date` is null or `>= CURRENT_DATE`)) or `NOT_PURCHASED` (its negation). The `course` dimension matches `users.course_id` OR an `enrollments` row (use `EXISTS`; one row per student always). Counts and pages are distinct students ordered by `u.id` ascending with keyset cursor `id > cursor`.
- **Commits.** `<type>(audience): <subject>`, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run the module's tests with `./mvnw -q test -Dtest='com.mna.siabackend.audience.*Test'` (use `mvnw.cmd` on Windows if needed).

## Review Focus

1. A filter value containing quotes, semicolons, SQL comments or unicode: bound as a parameter, never concatenated; the response is an ordinary result or 400, never 500 (Task 3).
2. Student with two courses (`users.course_id` plus an `enrollments` row): counted once by `count`, paged once, explained correctly (Task 4).
3. Empty `ids`, 501 ids, duplicated ids and ids that do not exist in `lookup`: one entry per distinct requested id, `not_found` for unknown ones (Task 5).
4. Replayed or stale signatures, a body altered after signing, and a request with no key configured at all: 401 and no query executed (Task 2).
5. A request body that is not JSON or exceeds 1 MiB: 400 or 413 before any database access (Task 2).

---

### Task 1: Worktree, properties and a read-only datasource

**Files:**
- Create: `src/main/java/com/mna/siabackend/audience/AudienceProperties.java`, `audience/AudienceDataSourceConfig.java`, `docs/ops/audience-readonly-role.sql`, tests `audience/AudiencePropertiesTest.java`
- Modify: `src/main/resources/application.yml` (new keys)

**Interfaces:**
- Produces: `record AudienceProperties(boolean enabled, List<Key> keys, int maxBodyBytes, int maxPage, int maxLookupIds, int maxResolveInputs, int signatureWindowSeconds)` with nested `record Key(String id, String secret)` bound from `sia.audience.*`; `SIA_AUDIENCE_KEYS` is a comma-separated list `id:secret`; `enabled` defaults to false and the whole audience feature is inert (no beans exposing routes) when false. Bean `NamedParameterJdbcTemplate audienceJdbc` over a small dedicated Hikari pool (max 5) built from `SIA_AUDIENCE_DB_*`; when those are unset it reuses the application datasource (so tests and local runs work). `docs/ops/audience-readonly-role.sql` creates a role with `SELECT` only on `users`, `universities`, `colleges`/`colleges` equivalents, `courses`, `semesters`, `regulation_years`, `states`, `enrollments`, `user_devices`, `purchases` in schema `sia_books`.

- [ ] **Step 1: Create the worktree** `git -C C:\Repos\sia-backend worktree add .worktrees/audience-api -b feat/marketing-audience-api dev`; confirm `git status` is clean there.
- [ ] **Step 2: Write failing tests**: `parses id:secret pairs into keys`, `blank SIA_AUDIENCE_KEYS gives no keys`, `a malformed pair is rejected at startup`, `defaults are the spec limits`.
- [ ] **Step 3: Implement** properties and datasource config; add the keys to `application.yml` with `enabled: false` and empty keys.
- [ ] **Step 4: Run** the new tests (PASS); confirm the application context still starts in an existing `@SpringBootTest` (run one existing test class to prove nothing else broke).
- [ ] **Step 5: Commit** `feat(audience): configuration and read-only datasource`.

---


> **Amendments after Phase 1 (binding):** (1) The signed `path` is the request path plus query string exactly as the server receives it: `request.getRequestURI()` + (`?` + `getQueryString()` when present), no re-encoding or decoding, because the Phase 1 client signs and sends the WHATWG-URL-normalised form (e.g. `'` becomes `%27`). (2) Dimension values response is strictly `{"values":[{"value":..,"label":..}]}`. (3) Ids are ordered and cursored as text per the contract's canonical order; the conformance dataset uses equal-width numeric ids (1001-1120) so numeric order matches. (4) Declare dimensions `university`, `course`, `semester`, `signup_date`, `purchase_status` (and the others in Task 3) so the conformance dataset loads; dataset field `suppressed` maps to `users.active = false`. (5) Filter depth: each group counts 1 and a lone condition counts 1; depth over 3 is rejected. (6) Not-in semantics: a student with no value IS included by `not_in`. (7) Validation failures must be 400 (the suite accepts any 4xx but warns otherwise); auth failures exactly 401.

### Task 2: Request signature filter

**Files:**
- Create: `audience/AudienceSignatureFilter.java`, `audience/SignatureVerifier.java`, `audience/NonceStore.java`, `audience/CachedBodyRequest.java`, `audience/AudienceFilterConfig.java`, tests `audience/SignatureVerifierTest.java`, `audience/AudienceSignatureFilterTest.java`
- Modify: `config/WebConfig.java` (add `"/internal/audience/**"` to the existing `excludePathPatterns` list, nothing else)

**Interfaces:**
- Consumes: `AudienceProperties`.
- Produces: `SignatureVerifier.verify(String method, String path, String body, Map<String,String> headers, long nowSeconds): Result` where `Result` is `Ok(keyId)` or `Fail(reason)` with reasons `missing`, `unknown_key`, `bad_signature`, `stale`, `replayed`; `interface NonceStore { boolean firstUse(String nonce, Duration ttl); }` with a Redis implementation (`StringRedisTemplate.setIfAbsent`) and an in-memory one for tests/when Redis is unavailable (in-memory only when `enabled` and Redis bean missing, logged once); `AudienceSignatureFilter extends OncePerRequestFilter` registered only for `/internal/audience/*`; it reads at most `maxBodyBytes` (413 above), caches the body so the controller can read it, verifies, and answers `401` with an empty body on any failure and logs key id (if known), route and reason only. When `enabled` is false every request to the route answers 404.

- [ ] **Step 1: Write failing tests** (verifier): `a correctly signed request verifies`, `a tampered body fails`, `a different path fails`, `61 seconds old is stale and 59 passes`, `a repeated nonce is replayed`, `either of two keys verifies`, `unknown key id`, `no keys configured fails closed`, `comparison is constant time` (equal-length wrong signature returns bad_signature without exception). Filter tests with MockMvc/`MockHttpServletRequest`: `valid request reaches the handler`, `missing headers 401 and the handler is never called`, `body over 1 MiB is 413`, `disabled feature is 404`, `a log line never contains the secret or the body` (capture logs).
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** using `javax.crypto.Mac` HmacSHA256, `MessageDigest` SHA-256, `MessageDigest.isEqual` for comparison.
- [ ] **Step 4: Run** the tests (PASS) and one existing interceptor-related test class to confirm the WebConfig edit did not break others.
- [ ] **Step 5: Commit** `feat(audience): deny-by-default signed request filter`.

---

### Task 3: Filter tree model, validation and SQL compiler

**Files:**
- Create: `audience/model/FilterTree.java` (records), `audience/AudienceDimensions.java`, `audience/FilterValidator.java`, `audience/FilterCompiler.java`, tests `audience/FilterValidatorTest.java`, `audience/FilterCompilerTest.java`

**Interfaces:**
- Produces: `FilterTree` as a sealed type of `Group(op: AND|OR, children)` and `Condition(dimension, op, values)`; ops `eq,in,not_in,gt,lt,between,exists`; `AudienceDimensions.catalogue(): List<Dimension>` with keys `state`, `university`, `college`, `course`, `semester`, `regulation`, `purchase_status`, `signup_date`, each `{key,label,type,multiValued,valuesListable}` and the reserved `id`; `FilterValidator.validate(FilterTree): List<String>` (empty when valid; depth at most 3, only catalogue keys, `id` only with `in`/`not_in` and at most 1,000 values, `between` exactly two values, `exists` none, value types match); `FilterCompiler.compile(FilterTree): Compiled(String whereSql, Map<String,Object> params)` where every value is a named parameter, dimension keys map to a fixed column or sub-select by a switch (never from input text), `course` compiles to `(u.course_id IN (:p) OR EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = u.id AND e.course_id IN (:p)))`, `purchase_status` compiles to the exact purchased predicate or its negation, group precedence kept with parentheses.

- [ ] **Step 1: Write failing tests** (validator): `rejects depth 4`, `rejects an unknown dimension`, `id allowed only with in and not_in`, `id with 1001 values rejected`, `between needs two`, `type mismatch`. (Compiler): `eq binds a parameter`, `in binds a list`, `a value containing a quote, semicolon, -- and unicode appears only in params`, `not_in`, `between`, `exists`, `nested OR inside AND is parenthesised`, `course includes the enrollments EXISTS`, `purchase_status PURCHASED and NOT_PURCHASED`, `an unknown dimension throws IllegalArgumentException`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** the model, validator and compiler; Jackson deserialization for `FilterTree`: a group is `{"op": "and"|"or", "children": [...]}` (non-empty), a condition is `{"dimension", "op", "values"}`, a node is a group when it has `children`; depth counts groups with a lone condition as depth 1 (so group > group > condition is the maximum, depth 3); `date` values are ISO `YYYY-MM-DD` strings and number dimensions accept only JSON numbers. This matches `packages/marketing/src/audience/contract.ts` (read it).
- [ ] **Step 4: Run** the tests (PASS).
- [ ] **Step 5: Commit** `feat(audience): filter tree validation and parameterised compiler`.

---

### Task 4: Audience repository (count, members, explain, values)

**Files:**
- Create: `audience/AudienceRepository.java`, tests `audience/AudienceRepositoryTest.java` (H2 in PostgreSQL mode with a test schema script `src/test/resources/audience/schema-audience.sql` and a loader `AudienceFixtures.java`)

**Interfaces:**
- Consumes: `FilterCompiler.Compiled`, `audienceJdbc`.
- Produces: `long count(Compiled)`; `List<MemberRow> members(Compiled, Long afterId, int limit)` with `MemberRow(long id, String displayName)` (`displayName` masked as first letter of first name plus `***`; null when the name is blank) ordered `u.id ASC` with `u.id > :after`; `Explanation explain(FilterTree, long id)` evaluating each leaf condition for that student with the same compiled leaf SQL (`SELECT EXISTS(... AND u.id = :id)` per leaf) and the whole tree; `List<DimensionValue> values(String key, String q, int limit)` reading the master tables (`states`, `universities`, `colleges`, `courses`, `semesters`, `regulation_years`) with `ILIKE`-style `LOWER(name) LIKE :q` (escaped), ordered by name, capped at 200; `purchase_status` values are the two literals. All queries use the base predicate `u.active = TRUE`.

- [ ] **Step 1: Write failing tests** against H2 fixtures: `count equals the number of ids paged out`, `keyset pages have no duplicates and no gaps`, `a student with two courses is counted once`, `inactive students are excluded`, `purchase_status PURCHASED honours expiry and is_active`, `explain names which conditions matched`, `a hostile value returns an ordinary empty result`, `values search is case-insensitive and escaped for % and _`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** with `NamedParameterJdbcTemplate`; no string concatenation of values.
- [ ] **Step 4: Run** the tests (PASS). If an assertion needs PostgreSQL-only SQL that H2 cannot run, say so in the report and cover it in Task 8's Postgres acceptance run instead of weakening the query.
- [ ] **Step 5: Commit** `feat(audience): audience queries over a read-only datasource`.

---

### Task 5: Lookup and resolve

**Files:**
- Modify: `audience/AudienceRepository.java` (add methods); Create: `audience/model/LookupEntry.java`, tests extending `AudienceRepositoryTest.java`

**Interfaces:**
- Produces: `List<LookupEntry> lookup(List<Long> ids, String channel)`: exactly one entry per distinct requested id in request order; statuses `ok`, `not_found`, `suppressed` (reserved; returned when `u.active` is false), `unreachable` with reason (pinned vocabulary, same as the conformance suite: `no_email` when the email is blank, `unverified_email`, `no_valid_phone`, `no_active_device`, `opted_out` reserved; `no_valid_phone` for sms/whatsapp when phone is blank, `no_active_device` for push when there is no `user_devices` row with `active = true` and a non-empty `fcm_token`, `unverified_email` for email when `email_verified` is not true or email is blank); `ok` entries carry only the contract's fields: `email` (email channel), `phone` as `91`-prefixed digits only when `country_code` is absent (use `country_code` when present; normalise to digits) for sms/whatsapp, `devices[{token, platform}]` for push (`platform` from `device_os`), and `traits{firstName,lastName}` always (and for channel `none` only traits); `Map<String,Long> resolve(List<String> inputs)` matching inputs that look like an email (case-insensitive equality on `email`) or a phone (digits only compared to `phone_number` with and without country code) to user ids, returning matches and the unmatched inputs. Never selects password or any other column.

- [ ] **Step 1: Write failing tests**: `one entry per distinct id, unknown ids are not_found`, `an inactive student is suppressed`, `push without an active device is unreachable no_active_device`, `email unverified is unreachable unverified_email`, `ok email entry has the email and traits and nothing else`, `channel none returns traits only`, `resolve matches an email regardless of case`, `resolve matches a phone with and without country code`, `resolve reports unmatched inputs`, `the lookup SQL selects only allow-listed columns` (assert the SQL string does not contain password_hash).
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement.** Batch with `WHERE u.id IN (:ids)` and a second query for devices; assemble in memory.
- [ ] **Step 4: Run** the tests (PASS).
- [ ] **Step 5: Commit** `feat(audience): contact lookup and input resolution`.

---

### Task 6: Controller and DTOs

**Files:**
- Create: `audience/AudienceController.java`, `audience/dto/*.java`, tests `audience/AudienceControllerTest.java` (`@WebMvcTest` with the filter configuration imported)

**Interfaces:**
- Produces: `@RestController @RequestMapping("/internal/audience")` hosting `GET /schema`, `GET /dimensions/{key}/values?q=&limit=`, `POST /count`, `POST /members`, `POST /explain`, `POST /members/lookup`, `POST /members/resolve` mapped to the contract paths when prefixed (`/internal/audience/schema`, ...); request and response DTOs are records matching `contract.ts` field for field (`count` -> `{count, approximate?}`; `members` -> `{members:[{id, displayName?}], nextCursor}` with `id` as a string, cursor an opaque base64 of the last id; `lookup` body `{ids, channel}` -> `{entries:[...]}` (an object, never a bare array); `nextCursor` is always present, `null` on the last page; `resolve` body `{inputs}` -> `{matches:[{input,id}], unmatched}`); validation errors are 400 with `{error}` and no detail echoing input values; limits enforced (page over 1,000, ids over 500, inputs over 200 are 400); controller never logs bodies; responses carry `Cache-Control: no-store`.

- [ ] **Step 1: Write failing tests** (MockMvc with signed requests through the real filter): `schema lists the eight dimensions plus id is not listed`, `count returns the repository count`, `members pages with an opaque cursor`, `a page limit of 1001 is 400`, `lookup with 501 ids is 400`, `resolve with 201 inputs is 400 and the body of the error contains none of them`, `an invalid filter is 400`, `an unsigned request is 401`, `every response has Cache-Control no-store`.
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** the controller delegating to the validator, compiler and repository.
- [ ] **Step 4: Run** the audience tests (PASS) and one existing controller test class.
- [ ] **Step 5: Commit** `feat(audience): internal audience controller`.

---

### Task 7: Journey switch and index migration

**Files:**
- Modify: `service/NotificationJourneyService.java` (and the scheduler path that triggers journey sends, found by reading `scheduler/NotificationScheduler.java`), `application.yml`
- Create: `src/main/resources/db/migration/V147__audience_indexes.sql` (use the next free version number), test `service/NotificationJourneyServiceFlagTest.java`

**Interfaces:**
- Produces: property `sia.notifications.journeys.enabled` (default `true`, unchanged behaviour); when `false`, `recordEvent(...)` still records the event row (analytics) but does not schedule or send, and the scheduler's journey-dispatch step does nothing; one log line at startup states the state. The migration adds `CREATE INDEX IF NOT EXISTS` for the filter columns that lack one (check existing migrations first): `users(university_id)`, `users(course_id)`, `users(semester_id)`, `users(regulation_year_id)`, `users(state_id)`, `users(active, id)`, `enrollments(course_id, user_id)`, `purchases(user_id, is_active, expiry_date)`, `user_devices(user_id, active)`. No `CONCURRENTLY` (Flyway runs in a transaction); note in the report that a large production table may need the indexes created concurrently by hand first.

- [ ] **Step 1: Write failing tests**: `with the flag off recordEvent saves the event and schedules nothing`, `with the flag on behaviour is unchanged` (existing journey tests still pass untouched).
- [ ] **Step 2: Run** them; expect FAIL.
- [ ] **Step 3: Implement** the minimal edits and the migration.
- [ ] **Step 4: Run** the new test and the existing journey/notification test classes (PASS).
- [ ] **Step 5: Commit** `feat(audience): journey on/off switch and audience indexes`.

---

### Task 8: Acceptance against the conformance suite

**Files:**
- Create: `src/test/java/com/mna/siabackend/audience/ConformanceDatasetLoader.java` (reads the marketing package's `conformance/seed/dataset.json` and inserts it into the audience tables), `docs/ops/audience-acceptance.md`, `scripts/audience-acceptance.sh` (or `.ps1` on Windows)

**Interfaces:**
- Consumes: Phase 1 Task 14 deliverables: `packages/marketing/conformance/seed/dataset.json`, `expected.json`, and the CLI `bun conformance/cli.ts --base-url <url> --key-id <id> --secret <secret>`.
- Produces: a documented, repeatable run: start a Postgres (the OpenPanel dev stack's Postgres container is fine, a throw-away database), create only the tables the audience code reads (script derived from the entity definitions: `users, states, universities, colleges, courses, semesters, regulation_years, enrollments, user_devices, purchases`), load the dataset, start `sia-backend` with `SIA_AUDIENCE_ENABLED=true` and a test key, run the CLI, and record the summary. A Java integration test (`@SpringBootTest` with H2) loads the same dataset and asserts the repository results equal `expected.json` for counts and first pages.

- [ ] **Step 1: Write the failing integration test** loading `dataset.json` and comparing to `expected.json`.
- [ ] **Step 2: Run** it; expect FAIL until the loader and mapping exist.
- [ ] **Step 3: Implement** the loader and the acceptance script; run the full acceptance against a real Postgres and the CLI.
- [ ] **Step 4: Run** the CLI result must be `failed: []`; paste the summary into the report. Any difference in a PostgreSQL-only query shows up here.
- [ ] **Step 5: Commit** `test(audience): conformance acceptance run`.

---

### Task 9: Operations notes

**Files:**
- Create: `docs/ops/audience-api.md`

- [ ] **Step 1: Write** the operator note: env vars, key format and two-key rotation procedure, IP allow-list and TLS expectations at the proxy (the endpoints must never be published through any public site or CDN), the read-only role script, index migration caution for production, the journey flag and the cut-over order (shadow run in the marketing plugin first, then flip `sia.notifications.journeys.enabled=false`), log fields, and how to run the acceptance script.
- [ ] **Step 2: Verify** every env name and path in the note against the code with `grep`.
- [ ] **Step 3: Run** the whole audience test package and the existing test suite for the touched areas; record outputs.
- [ ] **Step 4: Commit** `docs(audience): operator notes`.

---

## Self-review notes

- **Spec coverage.** Contract endpoints (Tasks 5, 6), secured calls (Tasks 1, 2, 6), read-only role (Task 1), distinct-student course semantics (Tasks 3, 4), purchase status rule (Tasks 3, 4), journey switch (Task 7), indexes (Task 7), conformance acceptance (Task 8), operator notes (Task 9).
- **Spec amendment.** The spec lists `TokenInterceptor` and `SecurityConfig` as the allowed edits; the actual exclusion list lives in `WebConfig`, and `SecurityConfig` is already `permitAll`, so the single route exclusion goes in `WebConfig`. The spec is amended to match.
- **Order.** Tasks 1 to 7 can start any time. Task 8 needs the marketing plugin's Phase 1 Task 14 to exist.
