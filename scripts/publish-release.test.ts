import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPublishedContents,
  isPublished,
  packageSpecs,
  pendingPackages,
} from './publish-release';
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
      pendingPackages(release, [true, true, false, true, true]).map((item) => item.name),
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
    expect(pendingPackages(release, [true, true, true, true, true])).toEqual([]);
  });
  it('selects tags per package when stable and prerelease versions are both missing', () => {
    const mixed = {
      ...release,
      packages: release.packages.map((item) =>
        item.directory === 'postgres-adapter' ? { ...item, version: '0.8.1-rc.1+build.2' } : item,
      ),
    };
    expect(
      pendingPackages(mixed, [false, false, false, false, false]).map((item) => item.tag),
    ).toEqual(['latest', 'latest', 'next', 'latest', 'latest']);
    expect(pendingPackages(mixed, [true, true, false, true, true])[0].tag).toBe('next');
  });
  it('does not publish with an incomplete inventory', () => {
    expect(() => pendingPackages(release, [true])).toThrow('Incomplete');
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

const roots: string[] = [];
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'borecount-publication-test-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function archive(directory: string, filename: string, files: Record<string, string>): string {
  const source = join(directory, `${filename}-source`);
  for (const [name, bytes] of Object.entries(files)) {
    const target = join(source, 'package', name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, bytes);
  }
  const path = join(directory, filename);
  execFileSync('tar', [
    '-czf',
    path,
    '-C',
    source,
    ...Object.keys(files).map((name) => `package/${name}`),
  ]);
  return path;
}

describe('published artifact identity', () => {
  it('compares file bytes independent of archive layout and order', () => {
    const root = scratch();
    const candidate = archive(root, 'candidate.tgz', {
      'index.js': 'export const value = 1;',
      'package.json': '{"version":"0.8.0"}',
    });
    const published = archive(root, 'published.tgz', {
      'package.json': '{"version":"0.8.0"}',
      'index.js': 'export const value = 1;',
    });
    expect(readFileSync(candidate).equals(readFileSync(published))).toBe(false);
    expect(() => assertPublishedContents(candidate, published, 'pkg@0.8.0')).not.toThrow();
  });
  const driftCases: Record<string, string>[] = [
    { 'index.js': 'changed', 'README.md': 'docs' },
    { 'index.js': 'original' },
    { 'index.js': 'original', 'README.md': 'docs', 'new.sql': 'DDL' },
  ];
  for (const files of driftCases) {
    it('requires a version bump for changed, removed or added files', () => {
      const root = scratch();
      const published = archive(root, 'published.tgz', {
        'index.js': 'original',
        'README.md': 'docs',
      });
      const candidate = archive(root, 'candidate.tgz', files);
      expect(() => assertPublishedContents(candidate, published, 'pkg@0.8.0')).toThrow(
        'Bump the package version',
      );
    });
  }
});

function publicationFixture(drift: boolean) {
  const root = scratch();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const registry = join(root, 'registry');
  mkdirSync(registry);
  const manifest: ReleaseManifest = {
    ...release,
    packages: release.packages.map((item) => ({
      ...item,
      tarball: `borecount-${item.directory}-${item.version}.tgz`,
    })),
  };
  for (const item of manifest.packages) {
    const files = {
      'package.json': JSON.stringify({ name: item.name, version: item.version }),
      'index.js': 'original',
    };
    archive(root, item.tarball, files);
    if (drift && item.directory === 'express-routes') files['index.js'] = 'unversioned change';
    archive(registry, item.tarball, files);
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(
    join(bin, 'npm'),
    String.raw`#!/usr/bin/env bun
import { appendFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const root = process.env.REGISTRY_FIXTURE;
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
if (args[0] === 'view') {
  if (args[1].includes('postgres-adapter@0.8.1')) { console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1); }
  console.log(JSON.stringify('0.8.0'));
} else if (args[0] === 'pack') {
  if (!args.includes('--ignore-scripts')) throw new Error('Lifecycle scripts must be disabled');
  const [name, version] = args[1].slice('@borecount/'.length).split('@');
  const filename = 'borecount-' + name + '-' + version + '.tgz';
  copyFileSync(join(root, 'registry', filename), join(args[args.indexOf('--pack-destination')+1], filename));
  console.log(JSON.stringify([{filename}]));
} else { throw new Error('Unexpected npm mutation: ' + args[0]); }
`,
    { mode: 0o755 },
  );
  return {
    run: (dryRun: boolean) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./publish-release.ts', import.meta.url)),
          '--manifest',
          join(root, 'manifest.json'),
          ...(dryRun ? ['--dry-run'] : []),
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, REGISTRY_FIXTURE: root, PATH: `${bin}:${process.env.PATH}` },
        },
      ),
    calls: () =>
      readFileSync(join(root, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]),
  };
}
describe('publication preflight CLI', () => {
  it('checks existing contents and reports the adapter-only plan without publishing', () => {
    const fixture = publicationFixture(false);
    const result = fixture.run(true);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toEqual({
      pending: [{ package: '@borecount/postgres-adapter@0.8.1', tag: 'latest' }],
    });
    expect(fixture.calls().filter((args) => args[0] === 'pack')).toHaveLength(4);
    expect(fixture.calls().some((args) => args[0] === 'publish')).toBe(false);
  });
  it('aborts before any publication when a later existing package has drifted', () => {
    const fixture = publicationFixture(true);
    const result = fixture.run(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('@borecount/express-routes@0.8.0 differs from npm');
    expect(result.stderr).toContain('Bump the package version');
    expect(fixture.calls().some((args) => args[0] === 'publish')).toBe(false);
  });
});
