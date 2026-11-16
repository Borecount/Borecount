// Owns a new Compose project/volume and private temporary secrets only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
const scratch = mkdtempSync('/tmp/bc-compose-');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const env = { ...process.env, SELF_HOST_SECRETS_DIR: `${scratch}/secrets`, SELF_HOST_UID: String(process.getuid()), SELF_HOST_GID: String(process.getgid()), SELF_HOST_PORT: String(port) };
const project = `bc-selfhost-drill-${process.pid}`;
const run = (command, args) => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 240000 });
  assert.equal(result.status, 0, `${command} ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};
const compose = (...args) => run('docker', ['compose', '-p', project, '-f', 'compose.yml', ...args]);
try {
  run(process.execPath, ['scripts/config.mjs']);
  compose('build');
  compose('up', '-d', '--wait', 'postgres');
  compose('run', '--rm', 'operator', 'migrate');
  compose('exec', '-T', 'postgres', 'psql', '-Xq', '-U', 'ledger_admin', '-d', 'borecount_self_hosted', '-v', 'ON_ERROR_STOP=1', '-f', '/host-release/permissions.sql');
  compose('run', '--rm', 'operator', 'provision');
  compose('run', '--rm', 'operator', 'provision');
  compose('up', '-d', '--wait', 'api');
  const state = JSON.parse(compose('exec', '-T', 'api', 'node', '-e', "console.log(JSON.stringify({uid:process.getuid(),secrets:require('fs').readdirSync('/run/secrets')}))"));
  assert.notEqual(state.uid, 0); assert.deepEqual(state.secrets, ['app_config']);
  env.SELF_HOST_TENANT_INPUT = `${env.SELF_HOST_SECRETS_DIR}/tenant-02.json`;
  env.SELF_HOST_TENANT_NAME = 'Second Compose tenant';
  run(process.execPath, ['scripts/tenant.mjs']);
  compose('run', '--rm', 'operator', 'provision');
  compose('run', '--rm', 'operator', 'provision');
  const tenant = JSON.parse(readFileSync(`${env.SELF_HOST_SECRETS_DIR}/tenant.json`));
  const url = `http://127.0.0.1:${port}`;
  const getToken = async () => {
    const response = await fetch(`${url}/v1/auth/token`, { method: 'POST', headers: { 'x-api-key': tenant.rawApiKey } });
    assert.equal(response.status, 200); return (await response.json()).access_token;
  };
  const token = await getToken();
  const created = await fetch(`${url}/v1/ledgers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Durable Compose ledger' }) });
  assert.equal(created.status, 201); const ledger = await created.json();
  assert.equal((await fetch(`${url}/demo/session`, { method: 'POST' })).status, 404);
  compose('restart', 'api');
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/ready`)).ok) { healthy = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(healthy);
  const retained = await fetch(`${url}/v1/ledgers/${ledger.id}`, { headers: { authorization: `Bearer ${await getToken()}` } });
  assert.equal(retained.status, 200); assert.equal((await retained.json()).id, ledger.id);
  const logs = compose('logs', '--no-color', 'api');
  const app = JSON.parse(readFileSync(`${env.SELF_HOST_SECRETS_DIR}/app.json`));
  for (const secret of [tenant.rawApiKey, token, app.JWT_SIGNING_KEY, app.DATABASE_URL, app.AUTH_DATABASE_URL]) assert.ok(!logs.includes(secret));
  console.log('Self-hosted Compose passed: image build, secret mounts, unprivileged API, migrations, permissions, provisioning/retry, readiness, auth, durable restart and log privacy');
} catch (error) {
  let diagnostic = compose('logs', '--no-color');
  for (const name of ['admin', 'app', 'auth', 'migrator', 'operator']) {
    diagnostic = diagnostic.replaceAll(readFileSync(`${env.SELF_HOST_SECRETS_DIR}/${name}.password`, 'utf8').trim(), '[redacted]');
  }
  console.error(diagnostic);
  throw error;
} finally {
  compose('down', '-v', '--remove-orphans');
  rmSync(scratch, { recursive: true, force: true });
}
