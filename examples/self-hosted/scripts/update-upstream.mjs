/**
 * Refreshes the example's vendored PostgreSQL operational assets from a Git tag.
 * Resolves the tag to one immutable commit, downloads all files before replacing
 * the old snapshot, and records their hashes while preserving backup-runner ancestry.
 * This updates source files only; it never connects to or changes a database.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = 'Borecount/Borecount';
const assets = ['LICENSE', 'examples/security/least-privilege.sql', 'scripts/portable-verify.sql'];
const shaPattern = /^[a-f0-9]{40}$/;

export async function updateUpstream({ ref, directory = fileURLToPath(new URL('../deploy/upstream/', import.meta.url)), fetchImpl = fetch }) {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(ref ?? '')) {
    throw new Error('Supply an explicit release tag, for example --ref v0.9.0');
  }
  const request = async url => {
    const response = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`Release asset request failed: HTTP ${response.status}`);
    return response;
  };
  let { object } = await (await request(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(ref)}`)).json();
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    if (!shaPattern.test(object.sha)) throw new Error('Invalid release tag identity');
    ({ object } = await (await request(`https://api.github.com/repos/${repository}/git/tags/${object.sha}`)).json());
  }
  if (object?.type !== 'commit' || !shaPattern.test(object.sha)) throw new Error('Release tag must resolve to a commit');
  const commit = object.sha;
  const previous = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const files = await Promise.all(assets.map(async name => {
    const response = await request(`https://raw.githubusercontent.com/${repository}/${commit}/${name}`);
    return [name, Buffer.from(await response.arrayBuffer())];
  }));
  const sha256 = Object.fromEntries(files.map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  const provenance = {
    repository: `https://github.com/${repository}`, tag: ref, commit, sha256,
    adapted: (previous.adapted ?? []).map(entry => ({
      ...entry, source_tag: entry.source_tag ?? previous.tag, source_commit: entry.source_commit ?? previous.commit,
    })),
  };
  const staging = await mkdtemp(join(dirname(directory), '.upstream-refresh-'));
  const backup = `${staging}-previous`;
  try {
    for (const [name, bytes] of files) {
      const target = join(staging, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    await writeFile(join(staging, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    await rename(directory, backup);
    try { await rename(staging, directory); }
    catch (error) { await rename(backup, directory); throw error; }
    await rm(backup, { recursive: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { ref: { type: 'string' } } });
    const provenance = await updateUpstream({ ref: values.ref });
    console.log(`Updated operational assets to ${provenance.tag} (${provenance.commit})`);
    console.log('Review git diff, then run npm test, npm run test:lifecycle and npm run test:compose');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Upstream refresh failed');
    process.exitCode = 1;
  }
}
