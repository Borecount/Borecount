/**
 * Verifies the composed host against real PostgreSQL using synthetic data.
 * Creates and owns two new temporary clusters for installation, authorization,
 * posting/retries, upgrade and isolated recovery; then checks restored HTTP behavior,
 * log privacy and process shutdown. Never adopts an existing database.
 */
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { generateUuidV7 } from '@borecount/core/base';
import { borecountMigrationsPath } from '@borecount/postgres-adapter/migrations';
import { generateApiKey } from '@borecount/core/application';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { migrateSelfHosted } from '../scripts/migrate.mjs';

const started = performance.now();
const scratch = realpathSync(mkdtempSync('/tmp/bc-host-'));
const bin = process.env.PG_BIN ?? spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' }).stdout.trim();
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LC_ALL: 'C', PGCLIENTENCODING: 'UTF8' };
const run = (cmd, args, extra = {}, expected = 0) => {
  const result = spawnSync(cmd, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, expected, `${cmd} failed: ${result.stderr}`);
  return result.stdout;
};
const sql = (host, text, database = 'borecount_self_hosted') => run('psql', ['-XqAtw', '-v', 'ON_ERROR_STOP=1', '-c', text], { PGHOST: host, PGPORT: host === source ? '55443' : '55442', PGUSER: 'ledger_admin', PGDATABASE: database });
const dbUrl = (host, role) => `postgresql://${role}:synthetic-${role.slice(7)}@127.0.0.1:${host === source ? '55443' : '55442'}/borecount_self_hosted`;
const source = join(scratch, 'source'); const recovery = join(scratch, 'recovery');
const clusters = []; const clients = []; let server;
const jwt = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const logs = [];
const { createSelfHostedServer } = await tsImport('../src/host.ts', {
  parentURL: import.meta.url, tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
});
const config = host => ({ DATABASE_URL: dbUrl(host, 'ledger_app'), AUTH_DATABASE_URL: dbUrl(host, 'ledger_auth'), JWT_SIGNING_KEY: jwt, JWT_ISSUER: 'self-hosted-drill' });
const tool = (...args) => run('bun', ['run', 'scripts/backup.ts', ...args], { PGSERVICEFILE: join(scratch, 'services') });
try {
  for (const host of [source, recovery]) {
    mkdirSync(host, { mode: 0o700 });
    run('initdb', ['-D', join(host, 'data'), '-U', 'ledger_admin', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    run('pg_ctl', ['-D', join(host, 'data'), '-l', join(host, 'server.log'), '-o', `-k ${host} -p ${host === source ? '55443' : '55442'} -c listen_addresses='${host === source ? '127.0.0.1' : ''}'`, '-w', 'start']);
    clusters.push(host);
    sql(host, 'CREATE DATABASE borecount_self_hosted', 'postgres');
  }
  const variables = { PGHOST: source, PGPORT: '55443', PGUSER: 'ledger_admin', PGDATABASE: 'borecount_self_hosted',
    MIGRATOR_PASSWORD: 'synthetic-migrator', APP_PASSWORD: 'synthetic-app', AUTH_PASSWORD: 'synthetic-auth', OPERATOR_PASSWORD: 'synthetic-operator' };
  run('psql', ['-Xq', '-v', 'ON_ERROR_STOP=1', '-f', 'deploy/roles.sql'], variables);
  // Install the released baseline first, then exercise an actual forward schema upgrade.
  const folder = join(scratch, 'prior'); mkdirSync(join(folder, 'meta'), { recursive: true });
  const upstream = borecountMigrationsPath;
  const journal = JSON.parse(readFileSync(join(upstream, 'meta/_journal.json')));
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
  writeFileSync(join(folder, journal.entries[0].tag + '.sql'), readFileSync(join(upstream, journal.entries[0].tag + '.sql')));
  const migrator = postgres(dbUrl(source, 'ledger_migrator'), { max: 1, onnotice: () => {} }); clients.push(migrator);
  await migrate(drizzle(migrator), { migrationsFolder: folder });
  run('psql', ['-Xq', '-v', 'ON_ERROR_STOP=1', '-f', 'deploy/permissions.sql'], variables);
  const operatorConfig = join(scratch, 'operator.json');
  writeFileSync(operatorConfig, JSON.stringify({ OPERATOR_DATABASE_URL: dbUrl(source, 'ledger_operator') }), { mode: 0o600 });
  const tenants = [0, 1].map(i => ({ tenantId: generateUuidV7(new Date()), tenantName: `Synthetic tenant ${i}`, keyName: 'Initial admin', role: 'ADMIN', rawApiKey: generateApiKey() }));
  const keyIds = [];
  for (const command of tenants) {
    const input = join(scratch, 'tenant.json'); writeFileSync(input, JSON.stringify(command), { mode: 0o600 });
    const provisionEnv = { SELF_HOST_OPERATOR_CONFIG: operatorConfig, SELF_HOST_PROVISION_INPUT: input };
    const args = ['--import', 'tsx', 'src/provision.ts'];
    const execute = () => spawnSync(process.execPath, args, { cwd: resolve('.'), env: { ...env, ...provisionEnv }, encoding: 'utf8' });
    const badConfig = join(scratch, 'bad-operator.json');
    writeFileSync(badConfig, JSON.stringify({ OPERATOR_DATABASE_URL: dbUrl(source, 'ledger_operator') + '?sslmode=verify-full&sslmode=disable' }));
    const rejected = spawnSync(process.execPath, args, { cwd: resolve('.'), env: { ...env, ...provisionEnv, SELF_HOST_OPERATOR_CONFIG: badConfig }, encoding: 'utf8' });
    assert.equal(rejected.status, 1, 'Provisioning must reject duplicate TLS options');
    const initial = execute(); assert.equal(initial.status, 0, initial.stderr); assert.equal(JSON.parse(initial.stdout).created, true); keyIds.push(JSON.parse(initial.stdout).apiKeyId);
    const repeat = execute(); assert.equal(repeat.status, 0, repeat.stderr); assert.equal(JSON.parse(repeat.stdout).created, false);
    writeFileSync(input, JSON.stringify({ ...command, tenantName: 'Conflicting command' }));
    assert.equal(execute().status, 1);
  }
  // A baseline-only database must never be accepted by the HTTP host.
  await assert.rejects(() => createSelfHostedServer(config(source), false), /Pending package migrations/);
  await migrateSelfHosted(dbUrl(source, 'ledger_migrator'));
  run('psql', ['-Xq', '-v', 'ON_ERROR_STOP=1', '-f', 'deploy/permissions.sql'], variables);
  assert.equal(sql(source, 'SELECT count(*) FROM tenants').trim(), '2');
  const stream = { write: line => { logs.push(line); return true; } };
  // Capture the composed host's real structured logs, including readiness errors.
  server = await createSelfHostedServer(config(source), { stream });
  const request = async (method, url, token, payload, expected = 200, headers = {}) => {
    const response = await server.inject({ method, url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
    return response.body ? response.json() : null;
  };
  const token = async key => (await request('POST', '/v1/auth/token', null, null, 200, { 'x-api-key': key })).access_token;
  const latestMigration = JSON.parse(sql(source, `DELETE FROM drizzle.__drizzle_migrations
    WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)
    RETURNING json_build_object('id',id,'hash',hash,'created_at',created_at::text)`));
  await request('GET', '/ready', null, null, 503);
  await assert.rejects(() => createSelfHostedServer(config(source), false), /Pending package migrations/);
  sql(source, `INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES
    (${latestMigration.id},'${latestMigration.hash}',${latestMigration.created_at})`);
  await request('GET', '/ready', null);
  let firstToken = await token(tenants[0].rawApiKey); const secondToken = await token(tenants[1].rawApiKey);
  await request('POST', '/v1/assets', firstToken, { code: 'USD', scale: 2 }, 201);
  const ledger = await request('POST', '/v1/ledgers', firstToken, { name: 'Durable ledger' }, 201);
  const account = async (code, normal_side) => request('POST', '/v1/accounts', firstToken, {
    ledger_id: ledger.id, code, name: code, currency: 'USD', side: normal_side, overdraft_policy: 'ALLOW',
  }, 201);
  const debit = await account('DEBIT', 'DEBIT'); const credit = await account('CREDIT', 'CREDIT');
  const posting = { ledger_id: ledger.id, reference: 'durable-posting', currency: 'USD', entries: [
    { account_id: debit.id, signed_amount_minor: '100', currency: 'USD' },
    { account_id: credit.id, signed_amount_minor: '-100', currency: 'USD' },
  ] };
  const posted = await request('POST', '/v1/transactions', firstToken, posting, 201);
  assert.equal((await request('POST', '/v1/transactions', firstToken, posting)).transaction_id, posted.transaction_id);
  const conflict = { ...posting, entries: posting.entries.map(e => ({ ...e, signed_amount_minor: String(BigInt(e.signed_amount_minor) * 2n) })) };
  await request('POST', '/v1/transactions', firstToken, conflict, 400);
  await request('GET', `/v1/ledgers/${ledger.id}`, secondToken, null, 404, { 'x-tenant-id': tenants[0].tenantId });
  await request('POST', '/demo/session', null, null, 404);
  await request('POST', '/demo/library/execute', null, { operation: 'ledgers.list' }, 404);
  await request('POST', '/demo/reset', firstToken, null, 404);
  const serviceKey = await request('POST', '/v1/admin/api-keys', firstToken, { name: 'Restricted', role: 'SERVICE' }, 201);
  const serviceToken = await token(serviceKey.api_key);
  await request('POST', '/v1/admin/api-keys', serviceToken, { name: 'Denied', role: 'ADMIN' }, 403);
  const adjustment = { ledger_id: ledger.id, account_id: credit.id, offset_account_id: debit.id,
    reference: 'trusted-adjustment', amount_minor: '10', description: 'Synthetic correction',
    reason_code: 'PROVIDER_DIFFERENCE', actor_id: keyIds[0] };
  await request('POST', '/v1/adjustments/credit', serviceToken, { ...adjustment, actor_id: serviceKey.key.id }, 403);
  await request('POST', '/v1/adjustments/credit', firstToken, { ...adjustment, actor_id: keyIds[1] }, 403);
  await request('POST', '/v1/adjustments/credit', firstToken, adjustment, 201);
  await request('POST', '/v1/adjustments/credit', firstToken, adjustment);
  const runtime = postgres(dbUrl(source, 'ledger_app'), { max: 1 }); clients.push(runtime);
  assert.equal((await runtime`select * from accounts`).length, 0);
  await assert.rejects(() => runtime`truncate accounts`);
  await assert.rejects(() => runtime`create table public.denied(id int)`);
  await assert.rejects(() => runtime`select * from borecount_security.find_active_api_key('x')`);
  const auth = postgres(dbUrl(source, 'ledger_auth'), { max: 1 }); clients.push(auth);
  await assert.rejects(() => auth`select * from api_keys`);
  await assert.rejects(() => createSelfHostedServer({ ...config(source), DATABASE_URL: dbUrl(source, 'ledger_operator') }, false));
  const before = sql(source, 'SELECT id, balance_minor FROM accounts ORDER BY id; SELECT id, reference FROM transactions ORDER BY id; SELECT id, signed_amount_minor FROM entries ORDER BY id');
  await server.close(); server = undefined;
  await migrateSelfHosted(dbUrl(source, 'ledger_migrator'));
  await migrateSelfHosted(dbUrl(source, 'ledger_migrator'));
  run('psql', ['-Xq', '-v', 'ON_ERROR_STOP=1', '-f', 'deploy/permissions.sql'], variables);
  assert.equal(sql(source, 'SELECT id, balance_minor FROM accounts ORDER BY id; SELECT id, reference FROM transactions ORDER BY id; SELECT id, signed_amount_minor FROM entries ORDER BY id'), before);
  // Verify mismatched history is refused before DDL.
  sql(source, 'CREATE TABLE public.unreviewed_host_data(id int)');
  await assert.rejects(() => migrateSelfHosted(dbUrl(source, 'ledger_migrator')));
  await assert.rejects(() => createSelfHostedServer(config(source), false));
  sql(source, 'DROP TABLE public.unreviewed_host_data');
  // Preserve the count while replacing an expected table: names must still fail closed.
  sql(source, 'ALTER TABLE public.recon_results RENAME TO unreviewed_host_data');
  await assert.rejects(() => migrateSelfHosted(dbUrl(source, 'ledger_migrator')), /table inventory/);
  await assert.rejects(() => createSelfHostedServer(config(source), false), /table inventory/);
  sql(source, 'ALTER TABLE public.unreviewed_host_data RENAME TO recon_results');
  sql(source, 'ALTER TABLE public.recon_runs DROP COLUMN matching_rule_ids');
  await assert.rejects(() => migrateSelfHosted(dbUrl(source, 'ledger_migrator')), /column inventory/);
  sql(source, 'ALTER TABLE public.recon_runs ADD COLUMN matching_rule_ids uuid[] NOT NULL');
  sql(source, 'DROP INDEX public.recon_runs_ledger_history_idx');
  await assert.rejects(() => migrateSelfHosted(dbUrl(source, 'ledger_migrator')), /Missing package index/);
  sql(source, 'CREATE INDEX recon_runs_ledger_history_idx ON public.recon_runs(tenant_id,ledger_id,started_at,id)');

  sql(source, "UPDATE drizzle.__drizzle_migrations SET hash = 'bad' WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)");
  await assert.rejects(() => migrateSelfHosted(dbUrl(source, 'ledger_migrator')));
  await assert.rejects(() => createSelfHostedServer(config(source), false), /Incompatible migration history/);
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(readFileSync(join(upstream, journal.entries.at(-1).tag + '.sql'))).digest('hex');
  sql(source, `UPDATE drizzle.__drizzle_migrations SET hash = '${hash}' WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`);
  // Backup checks require a quiesced full-DB snapshot, using the exact shipped tool.
  for (const client of clients) await client.end({ timeout: 5 }); clients.length = 0;
  writeFileSync(join(scratch, 'services'), `[source]\nhost=${source}\nport=55443\ndbname=borecount_self_hosted\nuser=ledger_admin\n`, { mode: 0o600 });
  const bundle = join(scratch, 'bundle');
  const backupStart = performance.now(); tool('backup', '--source', 'source', bundle);
  const backupSeconds = (performance.now() - backupStart) / 1000;
  const roles = run('pg_dumpall', ['--roles-only', '--no-role-passwords'], { PGHOST: source, PGPORT: '55443', PGUSER: 'ledger_admin' });
  // The installation administrator already exists in the new recovery cluster.
  const roleFile = join(scratch, 'roles.sql'); writeFileSync(roleFile, roles.replace(/^CREATE ROLE ledger_admin;\n/m, ''));
  run('psql', ['-Xq', '-v', 'ON_ERROR_STOP=1', '-f', roleFile], { PGHOST: recovery, PGPORT: '55442', PGUSER: 'ledger_admin', PGDATABASE: 'postgres' });
  const args = ['--socket', recovery, '--port', '55442', '--database', 'borecount_self_hosted', '--user', 'ledger_admin', bundle];
  const metadataPath = join(bundle, 'manifest.json');
  const metadata = JSON.parse(readFileSync(metadataPath));
  const dependencies = JSON.parse(readFileSync('package.json')).dependencies;
  assert.deepEqual(metadata.compatibility.packages,
    Object.fromEntries(Object.entries(dependencies).filter(([name]) => name.startsWith('@borecount/'))));
  assert.equal(metadata.compatibility.lock_sha256,
    createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'));
  for (const incompatible of [
    { ...metadata.compatibility, packages: { ...metadata.compatibility.packages, '@borecount/core': '0.0.0' } },
    { ...metadata.compatibility, lock_sha256: '0'.repeat(64) },
  ]) {
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, compatibility: incompatible }));
    const rejected = spawnSync('bun', ['run', 'scripts/backup.ts', 'restore', ...args], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /incompatible example dependencies, npm lockfile or Drizzle history/);
    assert.equal(sql(recovery, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'").trim(), '0',
      'Incompatible recovery metadata must be rejected before restoring any tables');
  }
  writeFileSync(metadataPath, JSON.stringify(metadata));
  tool('preflight', ...args);
  const restoreStart = performance.now(); tool('restore', ...args);
  const restoreSeconds = (performance.now() - restoreStart) / 1000;
  tool('verify', ...args);
  // A populated target must never be adopted by a second restore attempt.
  run('bun', ['run', 'scripts/backup.ts', 'restore', ...args], {}, 1);
  assert.equal(sql(recovery, 'SELECT id, balance_minor FROM accounts ORDER BY id; SELECT id, reference FROM transactions ORDER BY id; SELECT id, signed_amount_minor FROM entries ORDER BY id'), before);
  run('pg_ctl', ['-D', join(recovery, 'data'), '-m', 'fast', '-w', 'stop']);
  run('pg_ctl', ['-D', join(recovery, 'data'), '-l', join(recovery, 'server.log'), '-o', `-k ${recovery} -p 55442 -c listen_addresses='127.0.0.1'`, '-w', 'start']);
  server = await createSelfHostedServer(config(recovery), { stream });
  firstToken = await token(tenants[0].rawApiKey);
  assert.equal((await request('POST', '/v1/transactions', firstToken, posting)).transaction_id, posted.transaction_id);
  await request('POST', '/v1/transactions', firstToken, conflict, 400);
  await request('GET', `/v1/ledgers/${ledger.id}`, await token(tenants[1].rawApiKey), null, 404);
  await request('GET', '/ready', null);
  // Invalid credentials + query/body/header canaries must not enter application logs.
  const canary = 'PRIVATE_CANARY_LL132';
  await request('POST', '/v1/auth/token?private=' + canary, null, { canary }, 401, { 'x-api-key': canary, cookie: canary, 'x-request-id': canary + '\u2603' });
  const metrics = await server.inject('/metrics'); assert.match(metrics.body, /borecount_http_requests_total/);
  await request('POST', `/v1/admin/api-keys/${serviceKey.key.id}/revoke`, firstToken, {}, 204);
  await request('GET', '/v1/ledgers', serviceToken, null, 401);
  sql(recovery, 'REVOKE EXECUTE ON FUNCTION borecount_security.find_active_api_key(text) FROM borecount_authenticator');
  await request('GET', '/ready', null, null, 503);
  await request('POST', '/v1/auth/token', null, null, 500, { 'x-api-key': tenants[0].rawApiKey });
  sql(recovery, 'GRANT EXECUTE ON FUNCTION borecount_security.find_active_api_key(text) TO borecount_authenticator');
  await request('GET', '/ready', null);
  assert.ok(!logs.join('').includes('permission denied'));
  assert.ok(!logs.join('').includes(canary));
  for (const secret of [...tenants.map(t => t.rawApiKey), serviceKey.api_key, jwt, firstToken]) assert.ok(!logs.join('').includes(secret));
  await server.close(); server = undefined;
  // Exercise the actual process entry point, socket binding and SIGTERM shutdown.
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const appConfig = join(scratch, 'app.json'); writeFileSync(appConfig, JSON.stringify({ ...config(recovery), HOST: '127.0.0.1', PORT: String(port) }), { mode: 0o600 });
  // A failed listen must close the host pools rather than waiting for their idle timeout.
  const occupied = createServer(); occupied.listen(port, '127.0.0.1'); await once(occupied, 'listening');
  const failedHost = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: resolve('.'), env: { ...env, SELF_HOST_CONFIG: appConfig }, stdio: 'pipe' });
  const failedExit = once(failedHost, 'close');
  const failedTimer = setTimeout(() => failedHost.kill('SIGKILL'), 8000);
  try {
    const [code] = await failedExit;
    assert.equal(code, 1, 'Failed listen must exit normally after releasing resources');
    assert.equal(sql(recovery, "SELECT count(*) FROM pg_stat_activity WHERE usename IN ('ledger_app','ledger_auth')").trim(), '0');
  } finally { clearTimeout(failedTimer); await new Promise(resolve => occupied.close(resolve)); }
  const processHost = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: resolve('.'), env: { ...env, SELF_HOST_CONFIG: appConfig }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(processHost, 'close'); let output = ''; processHost.stdout.on('data', d => { output += d; }); processHost.stderr.on('data', d => { output += d; });
  try {
    let ready = false;
    for (let i = 0; i < 100 && processHost.exitCode === null; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, output); processHost.kill('SIGTERM');
    const timer = setTimeout(() => processHost.kill('SIGKILL'), 15000);
    const [code] = await exited; clearTimeout(timer); assert.equal(code, 0, output);
  } finally { if (processHost.exitCode === null) processHost.kill('SIGKILL'); }
  console.log(JSON.stringify({ result: 'passed', runtime: process.version, postgres: run('psql', ['--version']).trim(),
    packages: { adapter: '0.8.1', other: '0.8.0' }, host: '0.8.1', upgrade: 'released baseline to unchanged full 0.8.0 migration chain',
    checks: ['clean install', 'initial/subsequent provisioning and retries', 'role separation', 'posting/retries', 'tenant isolation', 'upgrade preserves history', 'isolated restore', 'restored API retries', 'revocation', 'redacted logs', 'TLS URL policy', 'migration readiness/catalog', 'listen failure cleanup', 'readiness', 'graceful shutdown'],
    backupSeconds: +backupSeconds.toFixed(2), restoreSeconds: +restoreSeconds.toFixed(2), totalSeconds: +((performance.now() - started) / 1000).toFixed(2) }));
} finally {
  await server?.close();
  for (const client of clients) await client.end({ timeout: 5 });
  for (const host of clusters.reverse()) run('pg_ctl', ['-D', join(host, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(scratch, { recursive: true, force: true });
}
