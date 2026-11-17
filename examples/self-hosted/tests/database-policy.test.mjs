/** Regression cases for every host-owned connection URL, before network access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatabaseUrl } from '../src/database-policy.mjs';
import { migrateSelfHosted } from '../scripts/migrate.mjs';
import { tsImport } from 'tsx/esm/api';
const { createSelfHostedServer } = await tsImport('../src/host.ts', import.meta.url);
for (const query of [
  'sslmode=verify-full&sslmode=disable', 'sslmode=disable&sslmode=verify-full',
  '%73slmode=verify-full&sslmode=disable', 'application_name=a&application_name=b',
  'sslmode=verify-full&host=other.invalid', 'sslmode=verify-full&ssl=false',
]) {
  test(`rejects ambiguous or overriding connection options: ${query}`, async () => {
    const url = `postgresql://operator@remote.invalid/database?${query}`;
    assert.throws(() => parseDatabaseUrl(url));
    await assert.rejects(() => migrateSelfHosted(url));
    await assert.rejects(() => createSelfHostedServer({ DATABASE_URL: url, AUTH_DATABASE_URL: url.replace('operator@', 'auth@') }, false));
  });
}
test('requires verified TLS remotely and accepts explicit local targets', () => {
  for (const suffix of ['', '?sslmode=disable', '?sslmode=require']) {
    assert.throws(() => parseDatabaseUrl(`postgresql://user@remote.invalid/db${suffix}`), /verified TLS/);
  }
  assert.equal(parseDatabaseUrl('postgresql://user@remote.invalid/db?sslmode=verify-full').hostname, 'remote.invalid');
  assert.equal(parseDatabaseUrl('postgresql://user@localhost/db').hostname, 'localhost');
});
