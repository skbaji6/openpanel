# @openpanel/nudge

Journey nudges for OpenPanel: a separate worker that consumes the events Kafka topic and sends email, push and webhook nudges. Its tables live in the Postgres schema `nudge`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres; `connection_limit` is set from `NUDGE_DB_POOL` |
| `REDIS_URL` | required | Redis |
| `ENCRYPTION_KEY` | required | Encrypts channel config; unsubscribe token key is derived from it |
| `NUDGE_PROXY_SECRET` | required | Shared secret with the dashboard proxy |
| `NUDGE_PUBLIC_URL` | required | Base URL for unsubscribe links |
| `NUDGE_PORT` | 4100 | HTTP port |
| `NUDGE_TRUST_PROXY` | false | Take the client IP from `x-forwarded-for` (see below) |
| `NUDGE_GRACE_SECONDS` | 300 | Window in which an observed goal cancels a pending nudge |
| `NUDGE_MAX_LAG` | 1000 | Consumer lag above which work is shed |
| `NUDGE_TICK_MS` | 5000 | Ticker interval |
| `NUDGE_LEASE_SECONDS` | 120 | Lease on claimed steps |
| `NUDGE_EVENT_RETENTION_DAYS` | 30 | Event retention |
| `NUDGE_CLAIM_BATCH` | 200 | Steps claimed per tick |
| `NUDGE_SEND_CONCURRENCY` | 10 | Concurrent sends |
| `NUDGE_DB_POOL` | 10 | Prisma pool size (the DB is shared with core) |
| `NUDGE_WEBHOOK_ALLOW_HOSTS` | empty | Comma list of internal hosts webhooks may reach |
| `NUDGE_KAFKA_GROUP` | nudge | Consumer group id |
| `KAFKA_BROKERS` | required | Comma list |
| `KAFKA_EVENTS_TOPIC` | required | Topic carrying ingested events |
| `KAFKA_CLIENT_ID` | openpanel-nudge | Client id |
| `KAFKA_SSL`, `KAFKA_SSL_CA_PATH`, `KAFKA_SSL_REJECT_UNAUTHORIZED` | unset | TLS; on by default when SASL is set |
| `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_SASL_MECHANISM` | unset, `scram-sha-512` | SASL needs both username and password |

A blank value counts as unset.

### Client IP and `NUDGE_TRUST_PROXY`

Failed API-key attempts and invalid unsubscribe tokens are limited to 30 per minute per client IP (valid keys and valid unsubscribe links are never limited). With `NUDGE_TRUST_PROXY=false` the client IP is the socket's peer address: behind a reverse proxy every caller shares the proxy's address and therefore one limit. Set it to `true` only when `NUDGE_PORT` is reachable solely through exactly one trusted proxy that appends the client address to `x-forwarded-for`; the worker then uses the rightmost entry. Anything that can reach the port directly could otherwise choose its own IP.

### Dashboard variables

The dashboard's `/api/nudge/*` proxy is off (404) until both are set on the dashboard process:

| Variable | Meaning |
|---|---|
| `NUDGE_URL` | Where the dashboard reaches the worker, e.g. `http://op-nudge:4100` |
| `NUDGE_PROXY_SECRET` | Same value as the worker's |

Roles: every dashboard call is checked against core first. Organization owners and admins can change rules, channels, settings, reference sets and API keys, and read channel configuration; members can read rules, starter rules, settings, results and reference sets, and preview templates. Unsubscribe, contact and device sync are never reachable through the dashboard.

## Deploy

The worker image is `packages/nudge/Dockerfile`, built from the repository root:

```bash
docker build -f packages/nudge/Dockerfile -t openpanel-nudge:local .
```

It runs `bun src/worker.ts` as the non-root `bun` user, applies the plugin's own migrations (schema `nudge`) at start, serves `/nudge/*` on `NUDGE_PORT` and has a `HEALTHCHECK` on `GET /nudge/health`. No secret is baked in; Prisma's client is generated with a placeholder URL. Build from a clean checkout: the root `.dockerignore` (which the plugin may not edit) does not exclude `.worktrees/`, so building from a main checkout that has worktrees sends all of them as build context.

`docker-compose.nudge.yml` (repository root) is an override for the self-hosted stack, the `docker-compose.yml` that `openpanel init` renders from `self-hosting/docker-compose.template.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.nudge.yml up -d
```

`openpanel init` does not know about it: copy the file next to your `docker-compose.yml` and add `-f docker-compose.nudge.yml` to every compose command, upgrades included. It adds the `op-nudge` service (port 4100 on the compose network only, not published; waits for healthy `op-db`, `op-kv` and `op-rp`) and merges `NUDGE_URL=http://op-nudge:4100` and `NUDGE_PROXY_SECRET` into `op-dashboard`. The service name `op-dashboard` is the self-hosting one; the repository's development `docker-compose.yml` has no dashboard service and no healthchecks, so in development run `bun run --filter @openpanel/nudge start` instead of the override.

Values come from the install's `.env`, which already has `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY` and `KAFKA_BROKERS`. Add `NUDGE_PROXY_SECRET` (`openssl rand -hex 32`) and `NUDGE_PUBLIC_URL`; compose refuses to start without them. Optional: `NUDGE_IMAGE` (default `openpanel-nudge:local`) and `NUDGE_BUILD_CONTEXT` (default `.`, set it to a checkout of this repository when building from an install directory).

The shipped Caddyfile needs two additions, which the plugin cannot make for you (`self-hosting/caddy/` is upstream's):

```caddyfile
# Before `handle_path /api*`, which would otherwise send the dashboard's proxy to op-api.
handle /api/nudge/* {
    reverse_proxy op-dashboard:3000
}
# Unsubscribe links (<NUDGE_PUBLIC_URL>/nudge/unsubscribe); add /nudge/contacts* and /nudge/devices*
# too if your backend syncs contacts or devices from outside the compose network.
handle /nudge/unsubscribe* {
    reverse_proxy op-nudge:4100
}
```

With `NUDGE_PUBLIC_URL` set to your dashboard domain and Caddy as the only way in, set `NUDGE_TRUST_PROXY=true` (Caddy sets `X-Forwarded-For` to the client address).

## Upgrading from upstream

The plugin only adds files (see `AGENTS.md`, "Fork discipline"), so an upstream merge conflicts only in the touchpoints listed in `TOUCHPOINTS.md`:

1. `apps/start/src/components/sidebar-project-menu.tsx`: keep the one `<SidebarLink ... href={'/nudge'} ... label="Nudges" />` element; if upstream dropped `WorkflowIcon` from the imports, stop and ask rather than editing the import block.
2. `apps/start/src/routeTree.gen.ts` and `bun.lock`: take upstream's, then regenerate (`bun install`, and the dashboard's dev server or build for the route tree).

Afterwards run the plugin tests and `bun run typecheck`, and check `git diff --name-status <upstream>..HEAD` shows only added files besides those.

## End-to-end check

`scripts/e2e.ts` proves the whole path on a running stack: it creates an active rule through the worker's dashboard API (trigger `add_to_cart`, goal `purchase`, one webhook step at +10 s), points the project's webhook channel at a local receiver, sends `add_to_cart` for a fresh profile through `POST $API_URL/track`, and expects exactly one delivery whose `x-nudge-signature` verifies against the channel secret. Then it sends `add_to_cart` and, a second later, `purchase` for another profile and expects no delivery. It prints `PASS delivered once`, `PASS signature verifies` and `PASS cancelled by goal`, and exits non-zero on any failure.

```bash
bun run dock:up                                  # Postgres, Redis, ClickHouse, Redpanda
bun run --filter @openpanel/api dev              # the API, with its worker role
NUDGE_GRACE_SECONDS=1 NUDGE_TICK_MS=1000 NUDGE_WEBHOOK_ALLOW_HOSTS=localhost \
  NUDGE_PROXY_SECRET=... NUDGE_PUBLIC_URL=http://localhost:4100 KAFKA_EVENTS_TOPIC=events \
  bun run --filter @openpanel/nudge start        # plus DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, KAFKA_BROKERS
NUDGE_URL=http://localhost:4100 NUDGE_PROXY_SECRET=... API_URL=$API_URL \
  E2E_PROJECT_ID=... E2E_CLIENT_ID=... E2E_CLIENT_SECRET=... DATABASE_URL=$DATABASE_URL \
  bun packages/nudge/scripts/e2e.ts
```

- Project and client ids come from `.seed.json` (a project whose client may send `profileId`, e.g. `acme-shop`).
- `NUDGE_GRACE_SECONDS` must be at least 1 (the config rejects 0).
- The receiver's host (`E2E_RECEIVER_HOST`, default `localhost`) must be in the worker's `NUDGE_WEBHOOK_ALLOW_HOSTS`, because plain http is only allowed for listed hosts.
- The script refuses a project that already has a webhook channel, because there is no API to restore it; use a dedicated project or set `E2E_ALLOW_WEBHOOK_OVERWRITE=true`. Afterwards the channel stays configured, pointing at the stopped receiver.
- It deletes its rule through the API and, when `DATABASE_URL` is set, the rule's enrollments and steps and the e2e profiles' rows in `nudge.events`. The two `nudge-e2e-*` profiles stay in core's ClickHouse.
- It never prints the proxy secret, client secret or webhook secret.

## Operations

- **Scaling.** The worker is one role: consumer, ticker, purge and HTTP API in one process. Run more replicas of the same service; they join one consumer group (`NUDGE_KAFKA_GROUP`) and split the topic's partitions, so replicas beyond the partition count idle on the consumer side. The ticker is safe on every replica (claims use row leases, `NUDGE_LEASE_SECONDS`). Each replica opens up to `NUDGE_DB_POOL` Postgres connections, against the same `max_connections` core uses.
- **Interest set.** Profiles with active enrollments are kept in Redis (`nudge:interest:profiles`), shared by all replicas and added the moment a profile enrolls. The event names that matter (triggers and goals of active rules) are held in each replica's memory; both are rebuilt from Postgres every 10 s, and right after a rule change through the API on the replica that handled it, so other replicas see a new rule within 10 s.
- **Lag gate.** Every 10 s the worker writes the group's total lag to `nudge.consumer_state`. The ticker sends nothing while that lag is above `NUDGE_MAX_LAG` or the value is older than 60 s, so a backlog never produces nudges whose goal events are still unread.
- **Retention.** Once a day each replica deletes `nudge.events` rows older than `NUDGE_EVENT_RETENTION_DAYS`.
- **Pre-filter.** See below for when the pre-filter stores every identified event.

Fork rules and touchpoints: see `AGENTS.md` and `TOUCHPOINTS.md`.

## Event pre-filter trade-off

The consumer drops most events before touching Postgres: it keeps an event when its name is a trigger or goal event of a live rule, or when its profile has an active enrollment. In a project with at least one active rule whose goal is `inactivity`, it keeps every event that carries a profile id instead. Events for one profile arrive on different Kafka partitions, so an activity event can reach a replica before the trigger that enrolls the profile. Without this rule that activity would be dropped and the inactivity nudge would go out anyway. The cost is that those projects store all identified events in `nudge.events` (bounded by `NUDGE_EVENT_RETENTION_DAYS`), and the pre-filter saves nothing for them. Anonymous events (no profile id) are always ignored.
