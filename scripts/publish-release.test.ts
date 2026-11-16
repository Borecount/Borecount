import { describe, expect, it } from 'bun:test';
import { isPublished, packageSpecs, pendingPackages } from './publish-release';
import { PUBLIC_PACKAGES, type ReleaseManifest } from './release-readiness';

const release: ReleaseManifest = {
  compatibilityLine: '0.8',
  contractVersion: '0.8.0',
  packages: PUBLIC_PACKAGES.map((directory) => ({
    name: `@borecount/${directory}`,
    directory,
    version: directory === 'postgres-adapter' ? '0.8.1' : '0.8.0',
    tarball: '',
    notes: '',
    gitTag: '',
  })),
};
describe('selective npm release', () => {
  it('publishes only the new adapter patch', () => {
    expect(
      pendingPackages(release, [true, true, false, true, true], 'latest').map((item) => item.name),
    ).toEqual(['@borecount/postgres-adapter']);
    expect(packageSpecs(release)).toEqual([
      '@borecount/core@0.8.0',
      '@borecount/http@0.8.0',
      '@borecount/postgres-adapter@0.8.1',
      '@borecount/fastify-routes@0.8.0',
      '@borecount/express-routes@0.8.0',
    ]);
  });
  it('skips all versions on a retry after publication', () => {
    expect(pendingPackages(release, [true, true, true, true, true], 'latest')).toEqual([]);
  });
  it('requires next only for pending prereleases', () => {
    const next = {
      ...release,
      packages: release.packages.map((item) =>
        item.directory === 'postgres-adapter' ? { ...item, version: '0.8.1-rc.1' } : item,
      ),
    };
    expect(pendingPackages(next, [true, true, false, true, true], 'next')).toHaveLength(1);
    expect(() => pendingPackages(next, [true, true, false, true, true], 'latest')).toThrow(
      'Invalid latest',
    );
    expect(() => pendingPackages(release, [true, true, false, true, true], 'next')).toThrow(
      'Invalid next',
    );
  });
  it('does not publish with an incomplete inventory', () => {
    expect(() => pendingPackages(release, [true], 'latest')).toThrow('Incomplete');
  });
  it('only treats structured E404 as missing', () => {
    expect(isPublished({ status: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' }, 'pkg')).toBe(
      false,
    );
    expect(isPublished({ status: 0, stdout: '"0.8.0"', stderr: '' }, 'pkg')).toBe(true);
    for (const code of ['E401', 'E403', 'EAI_AGAIN', 'E500']) {
      expect(() =>
        isPublished(
          { status: 1, stdout: JSON.stringify({ error: { code } }), stderr: code },
          'pkg',
        ),
      ).toThrow('Cannot check');
    }
    expect(() =>
      isPublished({ status: 1, stdout: 'invalid JSON E404', stderr: '' }, 'pkg'),
    ).toThrow('Cannot check');
  });
});
