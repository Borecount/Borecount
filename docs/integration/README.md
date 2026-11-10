# Integration Guide

## Choose an integration boundary

- Use `@borecount/fastify-routes` or `@borecount/express-routes` when embedding the complete HTTP surface in an existing host.
- Use `@borecount/core/application` with `@borecount/postgres-adapter` when composing services without the supplied routes.
- Use `@borecount/core` alone when implementing custom ports while preserving domain invariants.

## Host responsibilities

1. Provision PostgreSQL 16 and apply the migrations shipped by the adapter.
2. Create a database client and application services from `@borecount/postgres-adapter`.
3. Authenticate requests before route registration and populate tenant/API-key context.
4. Register exactly one framework adapter.
5. Expose liveness and dependency-aware readiness endpoints (the reference convention is `GET /health` and `GET /ready`), metrics, and structured JSON logs with at least timestamp, level, message, request ID, and tenant-safe context. Handle `SIGTERM`, stop accepting new work, drain in-flight requests, close database connections, and enforce a bounded timeout chosen for the deployment platform.
6. Keep all state-changing orchestration inside explicit transaction boundaries.

## Configuration ownership

`@borecount/postgres-adapter` reads `DATABASE_URL`, `DB_POOL_MAX`, `DB_IDLE_TIMEOUT`, and `DB_CONNECT_TIMEOUT`. A host may instead pass the corresponding database-client options directly. The core and HTTP contract packages do not read process configuration.

Authentication, rate limiting, bootstrap, server `PORT`, and `SHUTDOWN_TIMEOUT_MS` belong to the host application. The reference profile uses `JWT_ACCESS_TTL_SECONDS=900`; accepted configurable values are 300 through 900 seconds. Node.js does not load `.env` automatically: the host must use its runtime's env-file option or load a dotenv-compatible file before reading configuration.

## Contract conventions

- Send each ledger entry as a non-zero integer `signed_amount_minor` plus an ISO-style currency code. Positive values are debits and negative values are credits.
- Generate a unique stable transaction `reference`; retry the identical payload after timeouts.
- Treat a reference/payload mismatch as a client correctness error, not as a retryable conflict.
- Entry order is ignored during retry comparison, but every entry and duplicate occurrence must match by account, signed amount, and currency.
- Preserve `effective_at` separately from record creation time.
- Follow cursor pagination fields from the OpenAPI schemas rather than constructing cursors.
- Timestamp responses use milliseconds. A typed `where` timestamp with up to three fractional digits compares at millisecond precision. Four to six digits select an exact comparison, including when the extra digits are zero. This applies to each value in `in`. Cursors from before this change must be restarted when the filter contains a timestamp.
- Persist returned resource identifiers; do not derive IDs from names or references.

## Asset provisioning and discovery

Provision a code and its minor-unit scale with `POST /v1/assets` using an authenticated tenant
ADMIN. For example, `{"code":"EUR","scale":2}` registers EUR with two decimal places. The adapter
takes the tenant and role from the authenticated request context supplied by the host.

Use an authenticated tenant SERVICE token to discover scales from `GET /v1/assets` or
`GET /v1/assets/{id}`. Read the returned scale before converting amounts to or from minor units.
To find one code in a list, pass a URL-encoded `where` value such as `{"code":{"eq":"EUR"}}`.
Reuse the same filters when following `next_cursor`. The reference demo can use its existing
session token for these reads after upgrading to packages that include the asset routes.

## Recommended first scenario

Create a ledger, create two same-currency accounts, post one balanced transaction, retry it with the same reference, list its entries, and verify the trial balance. The reference demo provides the runnable commands; the request and response schemas remain canonical in [`openapi.yaml`](../../packages/http/openapi/openapi.yaml).

Before production use, review [invariants](../product/invariants.md), [limitations](../product/limitations.md), [operations runbooks](../runbooks/operations-auth-mvp.md), and [versioning](./versioning.md).

For self-hosted PostgreSQL role separation, tenant RLS, credential lookup, and disposable-database
verification, follow the [self-hosted security runbook](./self-hosted-security.md).

For credit and debit adjustments, the host must authenticate and authorize each request. Configure
the required adapter option using the [trusted actor integration pattern](./adjustment-authorization.md):
provide an authorization callback, or explicitly opt out with `authorizeAdjustment: false` only for a
trusted service that owns actor authorization. Missing options fail adapter registration.

## Troubleshooting

### Reference already exists with a different payload

Do not generate a new payload for an existing transaction reference. Retrieve or reconcile the original request, then retry only if ledger, currency, description, effective time, and entries are identical. A payload mismatch is an intentional [idempotency failure](../product/invariants.md#idempotency), not a transient database error.

### Currency or ledger mismatch

Verify that every account belongs to the target ledger and that each account and entry uses the transaction currency. Borecount rejects cross-ledger and mixed-currency postings before committing any effects; see the [posting invariants](../product/invariants.md#posting).

### Missing tenant context

Register authentication middleware before the route adapter and populate `tenantId`, `apiKeyId`, and `apiKeyRole` for every protected request. Never infer a tenant from a resource ID. Tenant-scoped repositories intentionally return not-found or authorization failures for cross-tenant access.

### Migration failure

Stop the rollout and keep application code at the version compatible with the current schema. Inspect the failed Drizzle migration, database permissions, and PostgreSQL version; restore from the deployment backup when required. Do not assume that downgrading a package rolls back the database. Follow the [upgrade procedure](./versioning.md#upgrade-procedure) and the [backup/restore runbook](../runbooks/backup-restore-drill-mvp.md).
