/** Regression cases for every host-owned connection URL, before network access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatabaseUrl } from '../src/database-policy.mjs';
import { migrateSelfHosted } from '../scripts/migrate.mjs';
import postgres from 'postgres';
import { tsImport } from 'tsx/esm/api';
const { createSelfHostedServer } = await tsImport('../src/host.ts', import.meta.url);
for (const query of [
  'sslmode=verify-full&sslmode=disable', 'sslmode=disable&sslmode=verify-full',
  '%73slmode=verify-full&sslmode=disable', 'application_name=a&application_name=b',
  'sslmode=verify-full&host=other.invalid', 'sslmode=verify-full&ssl=false',
]) {
  test(`rejects ambiguous or overriding connection options: ${query}`, async () => {
    const url = `postgresql://operator:test-password@remote.invalid/database?${query}`;
    assert.throws(() => parseDatabaseUrl(url));
    await assert.rejects(() => migrateSelfHosted(url));
    await assert.rejects(() => createSelfHostedServer({ DATABASE_URL: url, AUTH_DATABASE_URL: url.replace('operator:', 'auth:') }, false));
  });
}
test('requires verified TLS remotely and accepts explicit local targets', () => {
  for (const suffix of ['', '?sslmode=disable', '?sslmode=require']) {
    assert.throws(() => parseDatabaseUrl(`postgresql://user:test-password@remote.invalid/db${suffix}`), /verified TLS/);
  }
  assert.equal(parseDatabaseUrl('postgresql://user:test-password@remote.invalid/db?sslmode=verify-full').hostname, 'remote.invalid');
  assert.equal(parseDatabaseUrl('postgresql://user:test-password@localhost/db').hostname, 'localhost');
});

test('postgres hostname is plaintext only in the explicitly marked Compose container', async () => {
  const url = 'postgresql://user:test-password@postgres/database';
  for (const context of [{ env: {}, inDocker: true }, { env: { SELF_HOST_NETWORK: 'compose' }, inDocker: false }]) {
    assert.throws(() => parseDatabaseUrl(url, context), /verified TLS/);
    assert.equal(parseDatabaseUrl(url + '?sslmode=verify-full', context).hostname, 'postgres');
  }
  assert.equal(parseDatabaseUrl(url, { env: { SELF_HOST_NETWORK: 'compose' }, inDocker: true }).hostname, 'postgres');
  const previous = process.env.SELF_HOST_NETWORK;
  delete process.env.SELF_HOST_NETWORK;
  try {
    await assert.rejects(() => createSelfHostedServer({ DATABASE_URL: url,
      AUTH_DATABASE_URL: url.replace('user:', 'auth:'), SELF_HOST_NETWORK: 'compose' }, false), /verified TLS/);
  } finally {
    if (previous === undefined) delete process.env.SELF_HOST_NETWORK; else process.env.SELF_HOST_NETWORK = previous;
  }

});
test('pins the driver port instead of inheriting PGPORT', async () => {
  const old = process.env.PGPORT;
  process.env.PGPORT = '65432';
  const clients = [];
  try {
    const implicit = parseDatabaseUrl('postgresql://user:test-password@localhost/database');
    const explicit = parseDatabaseUrl('postgresql://auth:test-password@localhost:5432/database');
    assert.equal(implicit.port, '5432'); assert.equal(explicit.port, implicit.port);
    for (const url of [implicit, explicit]) {
      const client = postgres(url.href); clients.push(client);
      assert.deepEqual(client.options.port, [5432]);
    }
    const custom = parseDatabaseUrl('postgresql://user:test-password@localhost:55443/database');
    const client = postgres(custom.href); clients.push(client);
    assert.deepEqual(client.options.port, [55443]);
  } finally {
    if (old === undefined) delete process.env.PGPORT; else process.env.PGPORT = old;
    await Promise.all(clients.map(client => client.end()));
  }
});
test('never falls back to environment credentials', () => {
  for (const url of [
    'postgresql://localhost/database', 'postgresql://user@localhost/database',
    'postgresql://:password@localhost/database', 'postgresql://user:@localhost/database',
  ]) assert.throws(() => parseDatabaseUrl(url), /Explicit PostgreSQL username and password/);
  const url = parseDatabaseUrl('postgresql://user:p%40ssword@localhost/database');
  assert.equal(decodeURIComponent(url.password), 'p@ssword');
});
test('rejects IPv6 rather than delegating its interpretation to postgres 3.4.8', () => {
  for (const host of ['[::1]', '[2001:db8::1]']) {
    assert.throws(() => parseDatabaseUrl(`postgresql://user:password@${host}:5432/database?sslmode=verify-full`), /IPv6/);
  }
});
