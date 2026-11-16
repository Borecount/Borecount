/** Publish missing verified package versions and smoke-test the exact compatible set. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type PackageRelease, PUBLIC_PACKAGES, type ReleaseManifest } from './release-readiness';

type RegistryResult = { status: number | null; stdout: string; stderr: string };

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

export function pendingPackages(
  release: ReleaseManifest,
  published: boolean[],
  tag: string,
): PackageRelease[] {
  if (published.length !== release.packages.length)
    throw new Error('Incomplete npm version inventory');
  if (tag !== 'latest' && tag !== 'next') throw new Error('Unsupported npm distribution tag');
  const pending = release.packages.filter((_, index) => !published[index]);
  for (const item of pending) {
    const prerelease = item.version.split('+')[0].includes('-');
    if (prerelease !== (tag === 'next'))
      throw new Error(`Invalid ${tag} tag for ${item.name}@${item.version}`);
  }
  return pending;
}

export function packageSpecs(release: ReleaseManifest): string[] {
  return release.packages.map((item) => `${item.name}@${item.version}`);
}

async function publish(manifestPath: string, tag: string) {
  const release: ReleaseManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Inspect every tarball and registry version before publishing the first package.
  if (release.packages.length !== PUBLIC_PACKAGES.length)
    throw new Error('Incomplete release manifest');
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
    const result = spawnSync('npm', ['view', `${item.name}@${item.version}`, 'version', '--json'], {
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    return isPublished(result, `${item.name}@${item.version}`);
  });
  for (const item of pendingPackages(release, published, tag)) {
    execFileSync(
      'npm',
      [
        'publish',
        resolve(dirname(manifestPath), item.tarball),
        '--access',
        'public',
        '--provenance',
        '--tag',
        tag,
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
    options: { manifest: { type: 'string' }, tag: { type: 'string' } },
  });
  if (!values.manifest || !values.tag) throw new Error('--manifest and --tag are required');
  await publish(values.manifest, values.tag);
}
