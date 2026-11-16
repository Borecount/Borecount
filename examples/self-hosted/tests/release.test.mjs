import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('self-hosted recovery/security assets match the public release provenance', async () => {
  const root = new URL('../deploy/upstream/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)));
  assert.equal(provenance.commit, '3ec496370d9d55064a4ed3048bbd80608c232c3a');
  for (const [path, hash] of Object.entries(provenance.sha256)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), hash, path);
  }
  const { dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  for (const [name, version] of Object.entries(dependencies).filter(([name]) => name.startsWith('@borecount/'))) {
    const metadata = JSON.parse(await readFile(new URL(`packages/${name.split('/')[1]}/package.json`, root)));
    assert.equal(version, metadata.version, `${name}: shipped runtime/recovery versions must agree`);
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
