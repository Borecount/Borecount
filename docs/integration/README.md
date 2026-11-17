# Integration Guide

Borecount provides double-entry ledger packages for backend developers and CTOs of JavaScript
and TypeScript products with internal balances. Start by running the self-hosted example, then
choose how to embed the packages in your application.

## Start the self-hosted example

You need Git, Node.js 22, Docker with Compose v2, and a running Docker engine. From a terminal:

```sh
git clone https://github.com/Borecount/Borecount.git
cd Borecount/examples/self-hosted
npm ci
npm run setup
npm run up
npm run check
```

If you already followed the root README, keep that installation and continue below.
`check` should print `health: OK` and `ready: OK`. PostgreSQL runs in the container;
`setup` creates the initial tenant and private credentials. The default API listens only on
`http://127.0.0.1:8082`. No demo repository or commercial account is required.

See the [self-hosted README](../../examples/self-hosted/README.md) for installation defaults,
configuration overrides and recovery. This example uses published package versions pinned in its
own manifest and lockfile; use the matching package contracts when adapting it.

## Make your first posting

Run the following block in your terminal after setup, with Node.js 22 available. It uses Node's
built-in HTTP client and reads the generated initial ADMIN credential locally without printing it.
Use the same `SELF_HOST_PROJECT`, `SELF_HOST_SECRETS_DIR` and `SELF_HOST_PORT` values you used during
setup. Export them in this shell before running the block, or prefix the `node` command with the
assignments; values set only on an earlier `npm run setup` command do not carry over.

The scenario records a $10 wallet funding event: debit a clearing account and credit a wallet
liability account by 1,000 USD minor units. This records the event; it does not initiate a payment.
Each run creates a new ledger and two accounts. Within the run, the identical posting is submitted
twice to verify retry behavior.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const project = process.env.SELF_HOST_PROJECT ?? 'borecount-selfhost-01';
const directory = process.env.SELF_HOST_SECRETS_DIR ?? join(homedir(), '.local/share', project);
const tenant = JSON.parse(await readFile(join(directory, 'tenant.json'), 'utf8'));
const base = `http://127.0.0.1:${process.env.SELF_HOST_PORT ?? '8082'}`;
let token;
async function request(method, path, body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : { 'x-api-key': tenant.rawApiKey }),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status`);
  return response.json();
}
token = (await request('POST', '/v1/auth/token')).access_token;
const assets = await request('GET', '/v1/assets');
const usd = assets.data.find(asset => asset.code === 'USD');
if (usd) assert.equal(usd.scale, 2);
else await request('POST', '/v1/assets', { code: 'USD', scale: 2 }, 201);
const ledger = await request('POST', '/v1/ledgers', { name: 'First wallet' }, 201);
const account = (code, side) => request('POST', '/v1/accounts', {
  ledger_id: ledger.id, code, name: code, currency: 'USD', side,
  overdraft_policy: 'DISALLOW',
}, 201);
const clearing = await account('CLEARING', 'DEBIT');
const wallet = await account('WALLET', 'CREDIT');
const posting = {
  ledger_id: ledger.id, reference: `first-posting:${ledger.id}`, currency: 'USD',
  entries: [
    { account_id: clearing.id, signed_amount_minor: '1000', currency: 'USD' },
    { account_id: wallet.id, signed_amount_minor: '-1000', currency: 'USD' },
  ],
};
const first = await request('POST', '/v1/transactions', posting, 201);
assert.equal(first.created, true);
const retry = await request('POST', '/v1/transactions', posting);
assert.equal(retry.created, false);
assert.equal(retry.transaction_id, first.transaction_id);
const where = encodeURIComponent(JSON.stringify({ transaction_id: { eq: first.transaction_id } }));
const entries = await request('GET', `/v1/entries?where=${where}`);
assert.equal(entries.data.length, 2);
assert.equal(entries.next_cursor, null);
assert.equal(entries.data.reduce((sum, entry) => sum + BigInt(entry.signed_amount_minor), 0n), 0n);
const trial = await request('GET', `/v1/ledgers/${ledger.id}/trial-balance`);
assert.equal(trial.total_debits, '1000');
assert.equal(trial.total_credits, '1000');
console.log(JSON.stringify({
  transaction_id: first.transaction_id,
  first_created: first.created, retry_created: retry.created,
  entry_count: entries.data.length,
  total_debits: trial.total_debits, total_credits: trial.total_credits,
}, null, 2));
JS
```

Expected output (the transaction ID varies):

```json
{
  "transaction_id": "<generated transaction ID>",
  "first_created": true,
  "retry_created": false,
  "entry_count": 2,
  "total_debits": "1000",
  "total_credits": "1000"
}
```

The first posting returns HTTP `201`; the identical retry returns `200` and the same transaction ID.
The script fails if it observes duplicate entries or unexpected totals. Amounts are decimal strings
of integer minor units: `"1000"` means $10 for USD with scale 2. Positive entries are debits;
negative entries are credits. Account `side` describes its normal balance.

From `examples/self-hosted`, stop the installation with `npm run down`. It retains the database and
credentials; `npm run up` starts it again. There is no scheduled data reset.

## Embed Borecount in your application

Use the self-hosted host composition as an integration recipe to adapt. Your application owns
identity, authorization, configuration and deployment. Before production use, review the
[invariants](../product/invariants.md), [limitations](../product/limitations.md),
[self-hosted security runbook](./self-hosted-security.md), [operations runbooks](../runbooks/operations-auth-mvp.md)
and [versioning](./versioning.md). Request and response schemas are defined in
[OpenAPI](../../packages/http/openapi/openapi.yaml); check the contract shipped with your package version.

### Choose an integration boundary

- Use `@borecount/fastify-routes` or `@borecount/express-routes` when embedding the complete HTTP surface in an existing host.
- Use `@borecount/core/application` with `@borecount/postgres-adapter` when composing services without the supplied routes.
- Use `@borecount/core` alone when implementing custom ports while preserving domain invariants.

## Host responsibilities

1. Provision PostgreSQL 16 and apply the migrations shipped by the adapter.
2. Create a database client and application services from `@borecount/postgres-adapter`.
3. Authenticate requests before route registration and populate tenant/API-key context.
4. For an HTTP integration using the supplied routes, register exactly one framework adapter.
5. Expose liveness and dependency-aware readiness endpoints (the reference convention is `GET /health` and `GET /ready`), metrics, and structured JSON logs with at least timestamp, level, message, request ID, and tenant-safe context. Handle `SIGTERM`, stop accepting new work, drain in-flight requests, close database connections, and enforce a bounded timeout chosen for the deployment platform.
6. Keep all state-changing orchestration inside explicit transaction boundaries.

## Configuration ownership

`@borecount/postgres-adapter` reads `DATABASE_URL`, `DB_POOL_MAX`, `DB_IDLE_TIMEOUT`, and `DB_CONNECT_TIMEOUT`. A host may instead pass the corresponding database-client options directly. The core and HTTP contract packages do not read process configuration.

Authentication, rate limiting, bootstrap, server `PORT`, and `SHUTDOWN_TIMEOUT_MS` belong to the host application. The reference profile uses `JWT_ACCESS_TTL_SECONDS=900`; accepted configurable values are 300 through 900 seconds. Node.js does not load `.env` automatically: the host must use its runtime's env-file option or load a dotenv-compatible file before reading configuration.

## Contract conventions

- Send each ledger entry as a non-zero integer encoded as a decimal string in `signed_amount_minor`, plus an asset code provisioned for the tenant. Positive values are debits and negative values are credits.
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
Reuse the same filters when following `next_cursor`. The [reference demo](https://borecount.dev) can use its existing
session token for these reads after upgrading to packages that include the asset routes.

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

Stop the rollout and keep application code at the version compatible with the current schema. Inspect the failed Drizzle migration, database permissions, and PostgreSQL version; restore from the deployment backup when required. Do not assume that downgrading a package rolls back the database. Follow the [upgrade procedure](./versioning.md#consumer-upgrade-sequence) and the [backup/restore runbook](../runbooks/backup-restore-drill-mvp.md).
