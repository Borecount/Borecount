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
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { strictEqual } from 'node:assert';

const packageRoot = resolve('node_modules/@borecount/postgres-adapter');
const readmePath = resolve(packageRoot, 'README.md');
const runbookPath = resolve(packageRoot, 'dist/security/self-hosted-security.md');
const overlayPath = resolve(packageRoot, 'dist/security/least-privilege.sql');
const readme = await readFile(readmePath, 'utf8');
const runbook = await readFile(runbookPath, 'utf8');
const overlay = await readFile(overlayPath, 'utf8');

for (const [label, markdown, sourcePath] of [
  ['package README', readme, readmePath],
  ['security runbook', runbook, runbookPath],
]) {
  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
  for (const [, href] of links) {
    if (/^(?:[a-z]+:|#)/i.test(href)) continue;
    const target = resolve(dirname(sourcePath), href.split('#', 1)[0]);
    await access(target).catch(() => {
      throw new Error(`${label} has a broken packaged link: ${href}`);
    });
  }
}

strictEqual(overlay.includes('CREATE ROLE %I NOLOGIN'), true, 'Packed security SQL is missing no-login role creation');
strictEqual(overlay.includes('borecount_runtime'), true, 'Packed security SQL is missing the runtime role');
strictEqual(overlay.includes('find_active_api_key'), true, 'Packed security SQL is missing credential lookup functions');
strictEqual(runbook.includes('--file dist/security/least-privilege.sql'), true, 'Packed runbook does not point to the packaged overlay');
NODE

node --input-type=module <<'NODE'
const core = await import('@borecount/core');
const application = await import('@borecount/core/application');
const base = await import('@borecount/core/base');
const coreErrors = await import('@borecount/core/errors');
await import('@borecount/core/utils');
const http = await import('@borecount/http');
const contracts = await import('@borecount/http/contracts');
const httpErrors = await import('@borecount/http/errors');
const { deepStrictEqual, strictEqual, throws } = await import('node:assert');
deepStrictEqual([application.MAX_PAGE_LIMIT, application.MAX_FILTER_IN_VALUES], [200, 100]);
deepStrictEqual(contracts.MAX_PAGE_LIMIT, application.MAX_PAGE_LIMIT);
// Split entry points must share constructors, not merely accept branded copies.
strictEqual(core.Money, base.Money);
const generatedId = base.generateUuidV7(new Date('2026-11-05T12:00:00.000Z'));
strictEqual(base.isUuidV7(generatedId), true);
strictEqual(core.AccountId, base.AccountId);
strictEqual(core.LedgerService, application.LedgerService);
throws(() => new base.AccountId(''), coreErrors.InvalidIdError);
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
