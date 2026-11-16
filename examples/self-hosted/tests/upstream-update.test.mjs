/**
 * Verifies the source-refresh command without network access or a real checkout.
 * Covers annotated tag resolution, exact content hashes, preserved adapter ancestry
 * and keeping the old snapshot intact when a download or tag validation fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { updateUpstream } from '../scripts/update-upstream.mjs';

const commit = 'a'.repeat(40);
const old = { tag: 'v0.8.0', commit: 'b'.repeat(40), sha256: {}, adapted: [{ local_path: 'scripts/backup.ts', source_sha256: 'c'.repeat(64) }] };
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'borecount-upstream-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'upstream'); await mkdir(directory);
  await writeFile(join(directory, 'provenance.json'), JSON.stringify(old));
  await writeFile(join(directory, 'LICENSE'), 'Previous content');
  return directory;
}
function source(url) {
  if (url.includes('/git/ref/')) return Response.json({ object: { type: 'tag', sha: 'd'.repeat(40) } });
  if (url.includes('/git/tags/')) return Response.json({ object: { type: 'commit', sha: commit } });
  assert.ok(url.startsWith(`https://raw.githubusercontent.com/Borecount/Borecount/${commit}/`));
  return new Response(`Exact bytes for ${url}`);
}

test('upstream refresh pins an immutable commit and preserves adapted source identity', async t => {
  const directory = await fixture(t);
  const result = await updateUpstream({ ref: 'v0.9.0', directory, fetchImpl: async url => source(url) });
  assert.equal(result.commit, commit); assert.equal(result.tag, 'v0.9.0');
  assert.equal(Object.keys(result.sha256).length, 3);
  for (const [name, hash] of Object.entries(result.sha256)) {
    assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), hash);
  }
  assert.equal(result.adapted[0].source_tag, old.tag);
  assert.equal(result.adapted[0].source_commit, old.commit);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'provenance.json'))), result);
});

test('failed downloads leave the previous snapshot intact', async t => {
  const directory = await fixture(t);
  await assert.rejects(() => updateUpstream({ ref: 'v0.9.0', directory, fetchImpl: async url =>
    url.endsWith('least-privilege.sql') ? new Response('', { status: 503 }) : source(url) }), /HTTP 503/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'provenance.json'))), old);
  assert.equal(await readFile(join(directory, 'LICENSE'), 'utf8'), 'Previous content');
});

test('an unpinned branch is rejected before network access', async t => {
  const directory = await fixture(t);
  await assert.rejects(() => updateUpstream({ ref: 'main', directory, fetchImpl: () => assert.fail('Unexpected network') }), /explicit release tag/);
});
