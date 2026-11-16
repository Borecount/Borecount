/**
 * Checks that the standalone example consumes the intended public release.
 * Verifies bundled operational assets against their provenance hashes, coordinates
 * runtime/recovery package versions and rejects dependency resolution through the
 * parent repository's workspace packages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { createHash } from 'node:crypto';

const { readRecoveryRelease } = await tsImport('../scripts/backup.ts', import.meta.url);

test('self-hosted recovery/security assets match the public release provenance', async () => {
  const root = new URL('../deploy/upstream/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)));
  assert.equal(provenance.commit, '3ec496370d9d55064a4ed3048bbd80608c232c3a');
  for (const [path, hash] of Object.entries(provenance.sha256)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), hash, path);
  }
});

test('example resolves public packages from its own installation', () => {
  for (const name of ['core', 'http', 'postgres-adapter', 'fastify-routes']) {
    const resolved = import.meta.resolve(`@borecount/${name}`);
    assert.ok(resolved.startsWith(new URL(`../node_modules/@borecount/${name}/`, import.meta.url).href),
      `${name} must not resolve through the parent repository workspace`);
    assert.ok(resolved.endsWith('/dist/index.js'));
  }
});

test('recovery identity uses only the example dependencies and npm lockfile', async () => {
  const root = new URL('../', import.meta.url);
  const { dependencies } = JSON.parse(await readFile(new URL('package.json', root)));
  const identity = await readRecoveryRelease();
  assert.deepEqual(identity.packages,
    Object.fromEntries(Object.entries(dependencies).filter(([name]) => name.startsWith('@borecount/'))));
  assert.equal(identity.lock_sha256,
    createHash('sha256').update(await readFile(new URL('package-lock.json', root))).digest('hex'));
  assert.equal(identity.packages['@borecount/express-routes'], undefined);
});

test('recovery rejects stale locks, unresolved pins and mismatched release assets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'borecount-recovery-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'deploy', 'upstream'), { recursive: true });
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root)));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root)));
  const provenance = JSON.parse(await readFile(new URL('deploy/upstream/provenance.json', root)));
  await writeFile(join(directory, 'deploy', 'upstream', 'provenance.json'), JSON.stringify(provenance));
  const scenarios = [
    { name: 'stale root dependencies', change: (pkg, locked) => { pkg.dependencies.fastify = '0.0.0'; } },
    { name: 'resolved version mismatch', change: (pkg, locked) => { locked.packages['node_modules/@borecount/core'].version = '0.0.0'; } },
    { name: 'missing resolution', change: (pkg, locked) => { delete locked.packages['node_modules/@borecount/core']; } },
    { name: 'workspace link', change: (pkg, locked) => { locked.packages['node_modules/@borecount/core'].link = true; } },
    { name: 'unpinned dependency', change: (pkg, locked) => {
      pkg.dependencies['@borecount/core'] = '^0.8.0';
      locked.packages[''].dependencies['@borecount/core'] = '^0.8.0';
    } },
    { name: 'different bundled release', change: (pkg, locked) => {
      pkg.dependencies['@borecount/core'] = '0.9.0';
      locked.packages[''].dependencies['@borecount/core'] = '0.9.0';
      locked.packages['node_modules/@borecount/core'].version = '0.9.0';
    } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const pkg = structuredClone(manifest); const locked = structuredClone(lock);
      scenario.change(pkg, locked);
      await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
      await writeFile(join(directory, 'package-lock.json'), JSON.stringify(locked));
      await assert.rejects(() => readRecoveryRelease(directory));
    });
  }
});
