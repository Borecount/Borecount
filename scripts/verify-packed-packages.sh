#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="$ROOT_DIR/.tmp/package-smoke"
TARBALL_DIR="$SMOKE_DIR/tarballs"

rm -rf "$SMOKE_DIR"
mkdir -p "$TARBALL_DIR"

export npm_config_cache="$ROOT_DIR/.tmp/npm-cache"

pack_workspace() {
  npm pack --workspace "$1" --pack-destination "$TARBALL_DIR" >/dev/null
}

pack_workspace "@borecount/core"
pack_workspace "@borecount/http"
pack_workspace "@borecount/postgres-adapter"
pack_workspace "@borecount/fastify-routes"
pack_workspace "@borecount/express-routes"

cd "$SMOKE_DIR"
npm init --yes >/dev/null
npm install --ignore-scripts --no-package-lock "$TARBALL_DIR"/*.tgz

node --input-type=module <<'NODE'
const core = await import('@borecount/core');
const application = await import('@borecount/core/application');
await import('@borecount/core/base');
const coreErrors = await import('@borecount/core/errors');
await import('@borecount/core/utils');
const http = await import('@borecount/http');
const contracts = await import('@borecount/http/contracts');
const httpErrors = await import('@borecount/http/errors');
const { deepStrictEqual, throws } = await import('node:assert');
deepStrictEqual([application.MAX_PAGE_LIMIT, application.MAX_FILTER_IN_VALUES], [200, 100]);
deepStrictEqual(contracts.MAX_PAGE_LIMIT, application.MAX_PAGE_LIMIT);
// Other core entry points must throw the exact classes exported by the catalogue.
throws(() => core.Money.of(1n, 'USD').add(core.Money.of(1n, 'EUR')), coreErrors.CurrencyMismatchError);
throws(() => new core.AccountId(''), coreErrors.InvalidIdError);
throws(() => core.validateCreditGrant({ amountMinor: 0n }), coreErrors.InvalidCreditGrantError);
// Both HTTP entry points consume the canonical core error catalogue.
for (const mapError of [http.toHttpErrorPayload, httpErrors.toHttpErrorPayload]) {
  deepStrictEqual(mapError(new coreErrors.RateLimitExceededError(7)), {
    statusCode: 429,
    headers: { 'Retry-After': '7' },
    body: {
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      retry_after_seconds: 7,
    },
  });
}
await import('@borecount/http/mappers');
await import('@borecount/http/query/pagination');
await import('@borecount/http/route-core');
await import('@borecount/http/route-specs');
await import('@borecount/http/test/harness');
await import('@borecount/http/validation-utils');
await import('@borecount/postgres-adapter');
const drizzleConfig = await import('@borecount/postgres-adapter/drizzle-config');
const { access } = await import('node:fs/promises');
if (typeof drizzleConfig.borecountDrizzleSchemaPath !== 'string') {
  throw new Error('Missing Borecount Drizzle schema path export');
}
await access(drizzleConfig.borecountDrizzleSchemaPath);
if (Object.keys(drizzleConfig).some((name) => /luxledger/i.test(name))) {
  throw new Error('Unexpected legacy Drizzle configuration export');
}
await import('@borecount/postgres-adapter/schema');
await import('@borecount/fastify-routes');
await import('@borecount/express-routes');
NODE

node --input-type=commonjs <<'NODE'
require('@borecount/core');
require('@borecount/postgres-adapter/schema');
NODE

echo "Packed package smoke test passed."
