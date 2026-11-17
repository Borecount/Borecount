import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_PACKAGES, verifyReleaseReadiness } from './release-readiness';

const roots: string[] = [];
async function fixture(
  overrides: { version?: string; range?: string; httpVersion?: string; documented?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'borecount-release-'));
  roots.push(root);
  const version = overrides.version ?? '0.8.0';
  for (const directory of PUBLIC_PACKAGES) {
    await mkdir(join(root, 'packages', directory), { recursive: true });
    await writeFile(
      join(root, 'packages', directory, 'package.json'),
      JSON.stringify({
        name: `@borecount/${directory}`,
        version,
        dependencies:
          directory === 'http' ? { '@borecount/core': overrides.range ?? `~${version}` } : {},
      }),
    );
  }
  await mkdir(join(root, 'packages/http/openapi'), { recursive: true });
  await writeFile(
    join(root, 'packages/http/openapi/openapi.yaml'),
    `openapi: 3.1.0\ninfo:\n  title: Borecount\n  version: ${overrides.httpVersion ?? version}\npaths:\n  /v1/widgets:\n    post:\n      responses: {}\n`,
  );
  await mkdir(join(root, 'docs/releases'), { recursive: true });
  await writeFile(
    join(root, 'docs/releases', `${version}.md`),
    PUBLIC_PACKAGES.map((name) => `| \`@borecount/${name}\` | \`${version}\` |`).join('\n'),
  );
  await writeFile(join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}]\n`);
  await mkdir(join(root, 'docs/integration'), { recursive: true });
  await writeFile(
    join(root, 'docs/integration/idempotency.md'),
    overrides.documented === false ? '' : '`POST /v1/widgets`',
  );
  return root;
}
async function changePackage(root: string, directory: string, version: string) {
  const path = join(root, 'packages', directory, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = version;
  await writeFile(path, JSON.stringify(manifest));
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release readiness', () => {
  it('retains legacy coordinated release notes', async () => {
    const release = await verifyReleaseReadiness(await fixture());
    expect(release.compatibilityLine).toBe('0.8');
    expect(release.packages.every((item) => item.gitTag === 'v0.8.0')).toBe(true);
  });
  it('accepts independent patches and emits individual artifact identities', async () => {
    const root = await fixture({ range: '^0.8.0' });
    await changePackage(root, 'postgres-adapter', '0.8.1');
    await writeFile(
      join(root, 'docs/releases/postgres-adapter-0.8.1.md'),
      '| `@borecount/postgres-adapter` | `0.8.1` |',
    );
    await writeFile(join(root, 'CHANGELOG.md'), '## [0.8.0]\n## [postgres-adapter@0.8.1]\n');
    const release = await verifyReleaseReadiness(root);
    expect(release.contractVersion).toBe('0.8.0');
    expect(release.packages.map((item) => item.version)).toEqual([
      '0.8.0',
      '0.8.0',
      '0.8.1',
      '0.8.0',
      '0.8.0',
    ]);
    expect(release.packages[2]).toMatchObject({
      tarball: 'borecount-postgres-adapter-0.8.1.tgz',
      gitTag: 'postgres-adapter-v0.8.1',
      notes: 'docs/releases/postgres-adapter-0.8.1.md',
    });
  });
  it('accepts a lower supported minimum patch', async () => {
    expect(
      await verifyReleaseReadiness(await fixture({ version: '1.2.3', range: '~1.2.0' })),
    ).toHaveProperty('compatibilityLine', '1.2');
  });
  it('rejects a different minor line', async () => {
    const root = await fixture();
    await changePackage(root, 'postgres-adapter', '0.9.0');
    await expect(verifyReleaseReadiness(root)).rejects.toThrow('must share major.minor');
  });
  for (const range of ['^0.7.0', '^0.8.1', '*', '^1.2.0']) {
    it(`rejects incompatible minimum ${range}`, async () => {
      await expect(verifyReleaseReadiness(await fixture({ range }))).rejects.toThrow('range');
    });
  }
  it('rejects ranges spanning minor lines after 1.0', async () => {
    await expect(
      verifyReleaseReadiness(await fixture({ version: '1.2.3', range: '^1.2.0' })),
    ).rejects.toThrow('incompatible minimum');
  });
  it('rejects prereleases excluded by a stable dependency range', async () => {
    await expect(
      verifyReleaseReadiness(await fixture({ version: '0.8.1-rc.1', range: '^0.8.0' })),
    ).rejects.toThrow('incompatible minimum');
  });
  it('accepts an explicitly supported prerelease patch', async () => {
    expect(
      await verifyReleaseReadiness(await fixture({ version: '0.8.1-rc.2', range: '~0.8.1-rc.1' })),
    ).toHaveProperty('compatibilityLine', '0.8');
  });
  it('rejects OpenAPI drift from HTTP', async () => {
    await expect(verifyReleaseReadiness(await fixture({ httpVersion: '0.8.1' }))).rejects.toThrow(
      'must match HTTP package version',
    );
  });
  it('requires package-specific release documentation for a new patch', async () => {
    const root = await fixture();
    await changePackage(root, 'postgres-adapter', '0.8.1');
    await expect(verifyReleaseReadiness(root)).rejects.toThrow(
      'Release notes do not declare @borecount/postgres-adapter@0.8.1',
    );
  });
  for (const version of ['1.2', '0.8.1-01']) {
    it(`rejects invalid SemVer ${version}`, async () => {
      await expect(verifyReleaseReadiness(await fixture({ version }))).rejects.toThrow(
        'valid SemVer',
      );
    });
  }
  it('rejects undocumented state changes', async () => {
    await expect(verifyReleaseReadiness(await fixture({ documented: false }))).rejects.toThrow(
      'does not cover POST /v1/widgets',
    );
  });
});
