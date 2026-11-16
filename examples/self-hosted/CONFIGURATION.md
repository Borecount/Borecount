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

`/health` is liveness; `/ready` verifies DB role/schema composition and credential lookup. `/metrics`
exports bounded route/status request counts, latency and authentication failures. Restrict these at
ingress. Logs contain request ID, route template, tenant/key IDs when authenticated, status and
duration; no bodies, query strings, headers, SQL, driver diagnostics or cause chains. Request IDs are
limited to 1–64 ASCII letters/digits/underscore/hyphen; invalid IDs are replaced. All 5xx are sanitized
and logged with correlated safe context. Review platform/database logs separately.

See [README](README.md) for TLS/secret inputs, role ownership, upgrades and recovery. Run
`npm run test:lifecycle` for real DB posting, retries, isolation, redaction, readiness and shutdown;
`npm run test:compose` verifies the actual images, secret mounts and durable restart. These use only
new temporary synthetic installations. The example's bounds are a starting profile, not a load test.
