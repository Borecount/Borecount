/** Verify published contents, publish missing versions, and smoke-test the exact release set. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type PackageRelease, PUBLIC_PACKAGES, type ReleaseManifest } from './release-readiness';

type RegistryResult = { status: number | null; stdout: string; stderr: string };
type Publication = PackageRelease & { tag: 'latest' | 'next' };

export function isPublished(result: RegistryResult, spec: string): boolean {
  if (result.status === 0) return true;
  // npm's structured error code distinguishes a missing version from a registry/auth outage.
  let code: string | undefined;
  try {
    code = JSON.parse(result.stdout).error?.code;
  } catch {
    /* A malformed response is a failure. */
  }
  if (code === 'E404') return false;
  throw new Error(`Cannot check ${spec}: ${result.stderr || result.stdout}`);
}

export function pendingPackages(release: ReleaseManifest, published: boolean[]): Publication[] {
  if (published.length !== release.packages.length)
    throw new Error('Incomplete npm version inventory');
  return release.packages
    .filter((_, index) => !published[index])
    .map((item) => ({
      ...item,
      tag: item.version.split('+')[0].includes('-') ? 'next' : 'latest',
    }));
}

export function packageSpecs(release: ReleaseManifest): string[] {
  return release.packages.map((item) => `${item.name}@${item.version}`);
}

function archiveContents(archive: string): Map<string, string> {
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .trimEnd()
    .split('\n');
  const files = new Map<string, string>();
  for (const member of members) {
    if (!member.startsWith('package/') || member.split('/').includes('..'))
      throw new Error('Invalid npm archive path');
    if (member.endsWith('/')) continue;
    if (files.has(member)) throw new Error(`Duplicate npm archive file: ${member}`);
    // Read without extracting: archive metadata/order are irrelevant; filenames and bytes must match.
    const bytes = execFileSync('tar', ['-xOf', archive, member], { maxBuffer: 32 * 1024 * 1024 });
    files.set(member, createHash('sha256').update(bytes).digest('hex'));
  }
  return files;
}

export function assertPublishedContents(candidate: string, published: string, spec: string): void {
  const localFiles = archiveContents(candidate);
  const registryFiles = archiveContents(published);
  const changed = [...new Set([...localFiles.keys(), ...registryFiles.keys()])]
    .filter((name) => localFiles.get(name) !== registryFiles.get(name))
    .sort();
  if (changed.length)
    throw new Error(
      `${spec} differs from npm (${changed.slice(0, 10).join(', ')}). Bump the package version before publishing.`,
    );
}

function verifyPublication(manifestPath: string, release: ReleaseManifest): Publication[] {
  // Inspect every artifact and existing npm version before publishing the first package.
  if (release.packages.length !== PUBLIC_PACKAGES.length)
    throw new Error('Incomplete release manifest');
  const registry = mkdtempSync(join(tmpdir(), 'borecount-registry-'));
  try {
    const published = release.packages.map((item, index) => {
      const directory = PUBLIC_PACKAGES[index];
      if (
        item.directory !== directory ||
        item.name !== `@borecount/${directory}` ||
        item.tarball !== `borecount-${directory}-${item.version}.tgz` ||
        !/^[0-9A-Za-z.+-]+$/.test(item.version)
      ) {
        throw new Error('Invalid release artifact identity');
      }
      const archive = resolve(dirname(manifestPath), item.tarball);
      const packed = JSON.parse(
        execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }),
      );
      if (packed.name !== item.name || packed.version !== item.version)
        throw new Error(`Wrong artifact: ${item.tarball}`);
      const spec = `${item.name}@${item.version}`;
      const result = spawnSync('npm', ['view', spec, 'version', '--json'], { encoding: 'utf8' });
      if (result.error) throw result.error;
      const exists = isPublished(result, spec);
      if (exists) {
        const downloaded = JSON.parse(
          execFileSync(
            'npm',
            ['pack', spec, '--ignore-scripts', '--json', '--pack-destination', registry],
            { encoding: 'utf8' },
          ),
        );
        const filename = downloaded[0]?.filename;
        if (typeof filename !== 'string' || filename !== basename(filename))
          throw new Error(`Invalid registry artifact: ${spec}`);
        assertPublishedContents(archive, join(registry, filename), spec);
        console.log(`${spec} matches npm; skipping.`);
      }
      return exists;
    });
    return pendingPackages(release, published);
  } finally {
    rmSync(registry, { recursive: true, force: true });
  }
}

async function publish(manifestPath: string, dryRun: boolean) {
  const release: ReleaseManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pending = verifyPublication(manifestPath, release);
  console.log(
    JSON.stringify({
      pending: pending.map((item) => ({ package: `${item.name}@${item.version}`, tag: item.tag })),
    }),
  );
  if (dryRun) return;
  for (const item of pending) {
    execFileSync(
      'npm',
      [
        'publish',
        resolve(dirname(manifestPath), item.tarball),
        '--access',
        'public',
        '--provenance',
        '--tag',
        item.tag,
      ],
      { stdio: 'inherit' },
    );
  }
  const smoke = mkdtempSync(join(tmpdir(), 'borecount-published-'));
  try {
    writeFileSync(join(smoke, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    for (let attempt = 1; attempt <= 6; attempt++) {
      const installed = spawnSync(
        'npm',
        [
          'install',
          ...packageSpecs(release),
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--prefer-online',
        ],
        { cwd: smoke, stdio: 'inherit' },
      );
      if (installed.error) throw installed.error;
      if (installed.status === 0) break;
      if (attempt === 6)
        throw new Error('Published packages are not installable after six attempts');
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        "await Promise.all(process.argv.slice(1).map(name => import(name))); const {borecountMigrationsPath} = await import('@borecount/postgres-adapter/migrations'); const {access} = await import('node:fs/promises'); await access(borecountMigrationsPath + '/meta/_journal.json');",
        ...release.packages.map((item) => item.name),
      ],
      { cwd: smoke, stdio: 'inherit' },
    );
  } finally {
    rmSync(smoke, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { manifest: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  if (!values.manifest) throw new Error('--manifest is required');
  await publish(values.manifest, values['dry-run']);
}
