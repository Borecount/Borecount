# Example configuration and resource limits

The example reads `SELF_HOST_CONFIG` as a private JSON file, merged over process environment.
Compose mounts only `app.json` into the request container. Native processes may use environment
variables directly. Invalid settings fail startup without printing configuration or raw errors.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | Required | Non-owner runtime login with `borecount_runtime` membership. |
| `AUTH_DATABASE_URL` | Required | Separate authenticator login on the same database endpoint. |
| `DB_POOL_MAX` / `AUTH_DB_POOL_MAX` | 10 / 2 | Positive integer connection limits per process. |
| `DB_IDLE_TIMEOUT` / `DB_CONNECT_TIMEOUT` | 20 / 10 | Positive integer seconds. |
| `HOST` / `PORT` | `0.0.0.0` / 3000 | Bind address and integer port 1–65535. Compose publishes loopback only. |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | Positive integer hard shutdown deadline in milliseconds. |
| `JWT_SIGNING_KEY` | Required | Canonical unpadded base64url, at least 32 random bytes. |
| `JWT_PREVIOUS_SIGNING_KEYS` | Empty | Comma-separated old keys; no duplicates or current key. |
| `JWT_ISSUER` | `borecount-api` | Generated config selects `borecount-self-hosted`. |
| `JWT_ACCESS_TTL_SECONDS` | 900 | Integer 300–900. Key revocation is checked on every request. |
| `JWT_CLOCK_SKEW_SECONDS` | 5 | Integer 0–60. |
| `RATE_LIMIT_AUTH_TOKEN_MAX_REQUESTS` / `RATE_LIMIT_AUTH_TOKEN_WINDOW_SECONDS` | 20 / 60 | Token-exchange attempts per source IP per process. |
| `RATE_LIMIT_READ_MAX_REQUESTS` / `RATE_LIMIT_READ_WINDOW_SECONDS` | 600 / 60 | Reads per authenticated tenant per process. |
| `RATE_LIMIT_WRITE_MAX_REQUESTS` / `RATE_LIMIT_WRITE_WINDOW_SECONDS` | 120 / 60 | Non-GET/HEAD requests per authenticated tenant per process. |
| `RATE_LIMIT_ABUSE_MAX_REQUESTS` / `RATE_LIMIT_ABUSE_WINDOW_SECONDS` | 1200 / 60 | All `/v1/*` attempts per source IP before authentication/parsing. |
| `RATE_LIMIT_MAX_KEYS` | 10000 | Maximum keys in each of three independent limiter stores. Integer 1–100000. |
| `REQUEST_BODY_MAX_BYTES` | 1048576 | Integer 1–1048576; over-limit body returns 413. |
| `REQUEST_BULK_MAX_ITEMS` | 100 | Integer 1–100; over-limit transaction bulk count returns 400. |
| `REPORT_CONCURRENCY_MAX` / `REPORT_TENANT_CONCURRENCY_MAX` | 4 / 2 | Positive integers up to 1000; tenant cap cannot exceed global cap. |
| `TRUSTED_PROXY_CIDRS` | Empty | Explicit immediate-ingress IPs/CIDRs; no wildcard, boolean, hop count or `/0`. |

## Installation defaults

The npm management commands share these defaults. They do not require shell exports for the
single-installation case; override a value consistently when managing a different installation.

| Setting | Default |
| --- | --- |
| `SELF_HOST_PROJECT` | `borecount-selfhost-01` |
| `SELF_HOST_SECRETS_DIR` | `~/.local/share/<SELF_HOST_PROJECT>` |
| `SELF_HOST_PORT` | `8082`, published on loopback only |
| `SELF_HOST_UID` / `SELF_HOST_GID` | Current user's UID/GID |

Raw Compose commands remain available through `npm run compose -- <arguments>`, using the same
project, Compose file, secret directory and UID/GID. Secret paths and existing ancestors are
resolved through symlinks before validation; symlink aliases into the build context and dangling
symlinks are rejected. The application-level `start`, `migrate` and
`provision` scripts remain the native entry points used inside the containers.

## Authentication and ingress

Clients exchange `x-api-key` at `POST /v1/auth/token` for a bearer, then send it in the Authorization
header. Backing-key revocation is checked on every request. ADMIN keys manage tenant keys; SERVICE
keys cannot use `/v1/admin/*`. Adjustments require ADMIN and the authenticated key ID as `actor_id`,
including retries. Keep credentials out of URLs and logs. See the
[public API guide](https://github.com/Borecount/Borecount/blob/v0.8.0/docs/integration/README.md) and
[canonical contract](https://github.com/Borecount/Borecount/blob/v0.8.0/packages/http/openapi/openapi.yaml)
for financial commands and their idempotency rules.

All runtime, authentication, migration and provisioning URLs use one validation policy. Repeated
query parameters are rejected; only `sslmode` and `application_name` query keys are supported.
Endpoints and nonempty usernames/passwords must be explicit in every URL. A missing port is
normalized to `5432` before the driver sees the URL, so `PGPORT`, `PGUSER` and `PGPASSWORD` cannot
redirect these connections. Runtime and authentication must select the same endpoint/database.
Only `localhost` and `127.0.0.1` are local exceptions in native mode. The `postgres` hostname is
exempt only inside Docker with the internal `SELF_HOST_NETWORK=compose` marker supplied by
`compose.yml`; private JSON configuration cannot enable it. Other targets require
`sslmode=verify-full` and the operator's trust roots. IPv6 URLs are rejected because the pinned
postgres 3.4.8 driver does not reliably parse them.

Set `TRUSTED_PROXY_CIDRS` only to the actual immediate ingress peers after
verifying forwarding behavior. Never trust a caller-selected chain. Rotate database login secrets
through your secret store; JWT key overlap uses `JWT_PREVIOUS_SIGNING_KEYS`, removed after old tokens
expire plus clock skew.

## Resource controls

Rate counts accept integers 1–1000000; windows accept integer seconds 1–86400. Authenticated tenant
budgets follow credential verification. Client tenant headers and resource IDs cannot choose a
bucket. Token attempts and the general pre-auth budget use source IP independently; by default
forwarded IP/protocol headers are ignored. Behind an ingress, leave trust empty to share its IP
budget or allow only its actual immediate peer network after verifying forwarding behavior.

Quota, key-store and report-concurrency rejection returns 429, `Retry-After`, and the governed
`RATE_LIMIT_EXCEEDED` envelope. Fixed windows start with the first accepted attempt; rejected
requests do not extend them. Delay is rounded up to whole seconds. Concurrency rejection uses a
one-second backoff hint, not a completion prediction. There is no queue. Expired keys are reclaimed
lazily with bounded sweep frequency; active identities are not evicted to admit new ones.
At capacity, new identities fail closed until entries expire. Authentication, abuse and tenant stores
are separate; pre-auth churn does not evict tenant counters. Each tenant can use read and write keys.

Report permits cover balance-as-of, balance history, trial balance and account/credit-lot statements.
They are released only after the awaited service call completes, including failures. Disconnects do
not release a still-running operation early. Other expensive operations rely on request, rate and
pool limits; this example does not provide per-operation queues or a tenant export API.

Both pools share PostgreSQL capacity. Keep the global report cap below runtime pool capacity,
reserve room for mutations/auth/readiness, and budget all processes plus operator connections against
`max_connections`. Tune limits using measured payload memory, query duration, CPU and storage load.
The installed runtime role has 15-second statement/idle-transaction deadlines and a 2-second lock
wait; auth has a 5-second statement deadline. Configure longer deadlines only after measurement.
HTTP timeouts are not evidence that DB work stopped. Core batch/entry validation remains authoritative;
there are no independent host count knobs for every nested financial or reconciliation structure.

All quotas and metrics are process-local and ephemeral. Restarting resets counters; replicas multiply
allowances. Limits reduce shared-resource pressure but do not guarantee fairness or availability.
Distributed enforcement, ingress connection limits, dashboards and alerts are operator-owned.

## Monitoring and shutdown

`/health` is liveness; `/ready` verifies DB role/schema composition, credential lookup, and the
complete installed migration journal (timestamps and SQL hashes). Table/column names and required
index presence must match the installed migration chain; the API refuses pending migrations.
The runtime login receives read-only access to the library journal, not migration privileges.
These catalog checks cover the pinned release DDL, not arbitrary host schema or every possible
constraint/function alteration; recovery retains its separate SQL/invariant checks. `/metrics`
exports bounded route/status request counts, latency and authentication failures. Restrict these at
ingress. Logs contain request ID, route template, tenant/key IDs when authenticated, status and
duration; no bodies, query strings, headers, SQL, driver diagnostics or cause chains. Request IDs are
limited to 1–64 ASCII letters/digits/underscore/hyphen; invalid IDs are replaced. All 5xx are sanitized
and logged with correlated safe context. Review platform/database logs separately.

SIGTERM/SIGINT drains in-flight HTTP work, then closes both database pools. Allow a termination
grace period longer than `SHUTDOWN_TIMEOUT_MS` (Compose supplies 15 seconds for the default 10-second
deadline) and remove traffic before termination. See the [README](README.md) for release and
operator procedures, and [VERIFICATION.md](VERIFICATION.md) for observed checks.
