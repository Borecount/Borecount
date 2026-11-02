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
await import('@borecount/core');
await import('@borecount/core/application');
await import('@borecount/core/base');
await import('@borecount/core/utils');
await import('@borecount/http');
await import('@borecount/http/contracts');
await import('@borecount/http/errors');
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
