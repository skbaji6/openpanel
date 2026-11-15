# Reference audience API (Postgres)

A runnable implementation of the marketing plugin's audience contract (`src/audience/contract.ts`) over plain Postgres. It exists to prove the contract and to give other implementations something to compare against. It is not part of the worker image.

## Run it

```bash
psql "$DATABASE_URL" -f seed.sql          # creates the demo schema `reference_demo` only
export AUDIENCE_DATABASE_URL=postgresql://user:pass@localhost:5432/db
export AUDIENCE_KEYS="key1:secret1,key2:secret2"   # two keys, so one can be rotated out
export AUDIENCE_BASE_PATH=/internal/audience        # optional, default ''
export AUDIENCE_MAPPING=./mapping.json              # optional, default mapping.example.json
bun examples/audience-api-postgres/main.ts          # listens on AUDIENCE_PORT (default 4200)
```

Point a project's audience source at `http://host:4200<AUDIENCE_BASE_PATH>`. Use a read-only database role.

## The mapping

`mapping.example.json` describes your schema; the plugin has no vocabulary of its own. Names are validated at startup against `/^[a-zA-Z_][a-zA-Z0-9_.]*$/` and quoted. Each dimension is exactly one of:

- `column`: a column on the students table (`s`), single valued.
- `expression`: a trusted SQL expression over `s` for computed dimensions. The example `purchase_status` is `PURCHASED` for an active, unexpired purchase and `NOT_PURCHASED` otherwise. Expressions are configuration, never user input; each must be one self-contained SQL expression (`;`, `--`, `/*` and `*/` are rejected).
- `exists`: an EXISTS sub-select over a child relation, for multi-valued dimensions such as `course`. Students stay one row, so counts and pages are of distinct students.

Optional `memberCondition`: a trusted boolean expression over `s` (same rules as `expression`); students failing it are never audience members (count, members, explain), while `lookup` still reports them, for example `NOT s.suppressed`.

The example maps a `state` dimension (TS, AP) and returns it as `traits.state` on every ok lookup entry, as `docs/AUDIENCE_CONTRACT.md` requires for per-state journeys.

Also mapped: the id column (ids are served as text), the display name, contact columns (email, verified flag, phone, suppression flag, consent), traits, and the devices table. Only mapped columns are ever selected, so a password column cannot leak.

Contract notes: `not_in` includes students who have no value for the dimension (single valued: NULL; multi valued: no matching child row). Ids are compared and ordered as `id::text`; if your id column is already text, drop the cast in `idExpression` (compile.ts), otherwise add an expression index on `(id::text)` so paging and `id` conditions can use an index.

## Signing

Every request carries `Authorization: Bearer <keyId>.<secret>`, `X-Timestamp` (seconds), `X-Nonce` and `X-Signature`, an HMAC-SHA256 over method, path (as sent, including any query), timestamp, nonce and the SHA-256 of the body (`src/audience/signing.ts`). The server rejects timestamps more than 60 s off and repeated nonces. Any failure is `401 {"error":"unauthorized"}` with no detail, and nothing else runs. The nonce cache is in memory, so this is single-instance only; with several replicas use a shared store. Responses carry `Cache-Control: no-store`. Bodies are never logged.

## Limits

Page `limit` at most 1,000; lookup at most 500 ids; resolve at most 200 inputs; `id` conditions at most 1,000 values; filter depth at most 3; body at most 8 MB. Violations are `400 {"error"}` with a fixed message that never echoes input.

## Conformance

`../../conformance/seed/reference-mapping.json` maps this service onto the conformance seed (`conformance/seed/seed.sql`, schema `conformance_demo`); `conformance/conformance.test.ts` runs the suite against it. See `conformance/README.md`.

## Tests

`bun test examples` needs `DATABASE_URL` (the schema `reference_demo` is dropped and recreated; nothing else is touched).
