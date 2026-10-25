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

## Adopters

Installs created with `openpanel init` do not get the nudge service automatically: add the `docker-compose.nudge.yml` override to your compose invocation by hand and set the variables above.

Fork rules and touchpoints: see `AGENTS.md` and `TOUCHPOINTS.md`.

## Event pre-filter trade-off

The consumer drops most events before touching Postgres: it keeps an event when its name is a trigger or goal event of a live rule, or when its profile has an active enrollment. In a project with at least one active rule whose goal is `inactivity`, it keeps every event that carries a profile id instead. Events for one profile arrive on different Kafka partitions, so an activity event can reach a replica before the trigger that enrolls the profile. Without this rule that activity would be dropped and the inactivity nudge would go out anyway. The cost is that those projects store all identified events in `nudge.events` (bounded by `NUDGE_EVENT_RETENTION_DAYS`), and the pre-filter saves nothing for them. Anonymous events (no profile id) are always ignored.
