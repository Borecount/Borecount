/** Check that short commands use predictable defaults and isolate custom installations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { installationEnv, exampleRoot } from '../scripts/installation.mjs';
test('defaults need no exported Compose variables', () => {
  const env = installationEnv({});
  assert.equal(env.SELF_HOST_PROJECT, 'borecount-selfhost-01');
  assert.equal(env.SELF_HOST_SECRETS_DIR, join(homedir(), '.local/share/borecount-selfhost-01'));
  assert.equal(env.SELF_HOST_PORT, '8082');
  assert.equal(env.SELF_HOST_UID, String(process.getuid?.() ?? 1000));
});
test('a custom project gets separate credentials and explicit overrides survive', () => {
  assert.equal(installationEnv({ SELF_HOST_PROJECT: 'second' }).SELF_HOST_SECRETS_DIR, join(homedir(), '.local/share/second'));
  const env = installationEnv({ SELF_HOST_PROJECT: 'second', SELF_HOST_SECRETS_DIR: '/tmp/private-example', SELF_HOST_PORT: '8083', SELF_HOST_UID: '1001', SELF_HOST_GID: '1002' });
  assert.equal(env.SELF_HOST_SECRETS_DIR, join(realpathSync('/tmp'), 'private-example'));
  assert.equal(env.SELF_HOST_PORT, '8083');
  assert.equal(env.SELF_HOST_UID, '1001');
});
test('rejects ambiguous project names, invalid ports and secrets in the build context', () => {
  for (const project of ['', '../other', 'MixedCase']) assert.throws(() => installationEnv({ SELF_HOST_PROJECT: project }));
  for (const port of ['', '0', '65536', 'invalid']) assert.throws(() => installationEnv({ SELF_HOST_PORT: port }));
  for (const path of [exampleRoot, join(exampleRoot, 'private'), join(exampleRoot, '..secrets')]) {
    assert.throws(() => installationEnv({ SELF_HOST_SECRETS_DIR: path }), /outside/);
  }
});

test('resolves symlinked parents before accepting a not-yet-created secret directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'bc-path-policy-'));
  try {
    const alias = join(root, 'context-alias'); symlinkSync(exampleRoot, alias, 'dir');
    for (const path of [alias, join(alias, 'not-created', 'secrets')]) {
      assert.throws(() => installationEnv({ SELF_HOST_SECRETS_DIR: path }), /outside/);
    }
    const safe = join(root, 'safe'); mkdirSync(safe);
    const external = join(root, 'external'); symlinkSync(safe, external, 'dir');
    assert.equal(installationEnv({ SELF_HOST_SECRETS_DIR: join(external, 'new', 'secrets') }).SELF_HOST_SECRETS_DIR,
      join(realpathSync(safe), 'new', 'secrets'));
    const dangling = join(root, 'dangling'); symlinkSync(join(root, 'absent'), dangling, 'dir');
    assert.throws(() => installationEnv({ SELF_HOST_SECRETS_DIR: join(dangling, 'secrets') }), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
