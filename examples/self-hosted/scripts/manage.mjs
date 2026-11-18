/**
 * Runs the example's installation and routine Compose commands with shared defaults.
 * Setup resumes existing credentials, applies migrations and grants in order, and
 * provisions the persisted tenant command. Stop/down never delete database volumes.
 */
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { exampleRoot, installationEnv } from './installation.mjs';

const env = installationEnv();
function run(command, args, config = env) {
  const child = spawnSync(command, args, { cwd: exampleRoot, env: config, stdio: 'inherit' });
  if (child.error || child.status !== 0) throw new Error(`${command} failed; resolve the error before retrying`);
}
const compose = (...args) => run('docker', ['compose', '-p', env.SELF_HOST_PROJECT, '-f', join(exampleRoot, 'compose.yml'), ...args]);
async function configured() {
  for (const name of ['admin.password', 'migrator.password', 'app.password', 'auth.password', 'operator.password', 'app.json', 'operator.json', 'tenant.json']) {
    try { await access(join(env.SELF_HOST_SECRETS_DIR, name)); }
    catch { throw new Error('Installation configuration is incomplete; run setup for a new installation or restore its original secrets'); }
  }
}
function migrate() {
  compose('stop', 'api');
  compose('up', '-d', '--wait', 'postgres');
  compose('run', '--rm', 'operator', 'migrate');
  compose('exec', '-T', 'postgres', 'psql', '-X', '-U', 'ledger_admin', '-d', 'borecount_self_hosted', '-v', 'ON_ERROR_STOP=1', '-f', '/host-release/permissions.sql');
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'compose') compose(...args);
  else if (command === 'setup') {
    if (args.length) throw new Error('setup takes no arguments');
    try { await access(env.SELF_HOST_SECRETS_DIR); }
    catch { run(process.execPath, ['scripts/config.mjs']); }
    await configured();
    env.SELF_HOST_TENANT_INPUT = join(env.SELF_HOST_SECRETS_DIR, 'tenant.json');
    compose('build'); migrate(); compose('run', '--rm', 'operator', 'provision');
    console.log(`Setup complete. Private configuration: ${env.SELF_HOST_SECRETS_DIR}. Run npm run up.`);
  } else if (command === 'tenant:add' || command === 'tenant:provision') {
    const { values } = parseArgs({ args, options: { name: { type: 'string' }, role: { type: 'string' }, file: { type: 'string' } } });
    await configured();
    if (command === 'tenant:add') {
      if (!values.name?.trim()) throw new Error('Supply --name for the new tenant');
      env.SELF_HOST_TENANT_INPUT = values.file ?? join(env.SELF_HOST_SECRETS_DIR, `tenant-${randomUUID()}.json`);
      run(process.execPath, ['scripts/tenant.mjs'], { ...env, SELF_HOST_TENANT_NAME: values.name, SELF_HOST_TENANT_ROLE: values.role ?? 'ADMIN' });
      console.log(`Retain this input for retries: ${env.SELF_HOST_TENANT_INPUT}`);
    } else env.SELF_HOST_TENANT_INPUT = values.file ?? join(env.SELF_HOST_SECRETS_DIR, 'tenant.json');
    compose('run', '--rm', 'operator', 'provision');
  } else {
    if (args.length) throw new Error('Use npm run compose -- <arguments> for advanced Compose commands');
    if (command === 'down') compose('down');
    else if (command === 'status') compose('ps');
    else if (command === 'logs') compose('logs', '--follow', 'api');
    else {
      await configured();
      if (command === 'up') compose('up', '-d', '--wait', 'api');
      else if (command === 'db:migrate') migrate();
      else if (command === 'check') {
        for (const endpoint of ['health', 'ready']) {
          const response = await fetch(`http://127.0.0.1:${env.SELF_HOST_PORT}/${endpoint}`, { signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error(`${endpoint} failed`);
          console.log(`${endpoint}: OK`);
        }
      } else throw new Error('Unknown management command');
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
