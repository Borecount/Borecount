// Generates an offline installation's credentials once; never overwrites existing files.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateUuidV7 } from '@borecount/core/base';
import { generateApiKey } from '@borecount/core/application';

process.umask(0o077);
const directory = process.env.SELF_HOST_SECRETS_DIR;
if (!directory) throw new Error('SELF_HOST_SECRETS_DIR is required');
await mkdir(resolve(directory), { mode: 0o700 }); // An existing directory is deliberately rejected.
const passwords = Object.fromEntries(['admin', 'migrator', 'app', 'auth', 'operator'].map(name => [name, randomBytes(32).toString('hex')]));
const url = role => `postgresql://ledger_${role}:${passwords[role]}@postgres:5432/borecount_self_hosted`;
const files = {
  ...Object.fromEntries(Object.entries(passwords).map(([name, value]) => [`${name}.password`, value])),
  'app.json': JSON.stringify({ DATABASE_URL: url('app'), AUTH_DATABASE_URL: url('auth'),
    JWT_SIGNING_KEY: randomBytes(32).toString('base64url'), JWT_ISSUER: 'borecount-self-hosted',
    DB_POOL_MAX: '10', DB_IDLE_TIMEOUT: '20', DB_CONNECT_TIMEOUT: '10' }, null, 2),
  'operator.json': JSON.stringify({ MIGRATION_DATABASE_URL: url('migrator'), OPERATOR_DATABASE_URL: url('operator') }, null, 2),
  'tenant.json': JSON.stringify({ tenantId: generateUuidV7(new Date()), tenantName: 'Initial tenant', keyName: 'Initial admin',
    role: 'ADMIN', rawApiKey: generateApiKey() }, null, 2),
};
for (const [name, value] of Object.entries(files)) {
  const file = resolve(directory, name);
  await writeFile(file, `${value}\n`, { flag: 'wx', mode: 0o600 });
  if (name.endsWith('.password')) await chmod(file, 0o444);
}
console.log('Created private installation files. Retain tenant.json securely for provisioning retries.');
