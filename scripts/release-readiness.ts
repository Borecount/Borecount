/** Verify compatible package versions and produce the per-package publication manifest. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export const PUBLIC_PACKAGES = [
  'core',
  'http',
  'postgres-adapter',
  'fastify-routes',
  'express-routes',
] as const;

type PackageManifest = { name: string; version: string; dependencies?: Record<string, string> };
export type PackageRelease = {
  name: string;
  directory: string;
  version: string;
  tarball: string;
  notes: string;
  gitTag: string;
};
export type ReleaseManifest = {
  compatibilityLine: string;
  contractVersion: string;
  packages: PackageRelease[];
};

type Version = { value: string; major: number; minor: number; patch: number; prerelease: string[] };
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function version(value: string): Version {
  const match = typeof value === 'string' ? SEMVER.exec(value) : null;
  const numbers = match?.slice(1, 4).map(Number);
  const prerelease = match?.[4]?.split('.') ?? [];
  if (
    !match ||
    !numbers?.every(Number.isSafeInteger) ||
    prerelease.some((id) => /^0\d+$/.test(id))
  ) {
    throw new Error(`Public package version must be valid SemVer: ${value}`);
  }
  return { value, major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease };
}

function compare(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const)
    if (a[key] !== b[key]) return a[key] - b[key];
  if (!a.prerelease.length || !b.prerelease.length)
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const numericLeft = /^\d+$/.test(left);
    const numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function stateChangingOperations(source: string): string[] {
  const operations: string[] = [];
  let path: string | undefined;
  for (const line of source.split('\n')) {
    const pathMatch = line.match(/^ {2}(\/[^:]+):\s*$/);
    if (pathMatch) {
      path = pathMatch[1];
      continue;
    }
    const methodMatch = line.match(/^ {4}(post|put|patch|delete):\s*$/);
    if (path && methodMatch) operations.push(`${methodMatch[1].toUpperCase()} ${path}`);
  }
  return operations;
}

/** Verify a compatible release family while keeping each package's patch identity. */
export async function verifyReleaseReadiness(root: string): Promise<ReleaseManifest> {
  const manifests: PackageManifest[] = await Promise.all(
    PUBLIC_PACKAGES.map(async (directory) =>
      JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8')),
    ),
  );
  const versions = manifests.map((item) => version(item.version));
  const line = (item: Version) => `${item.major}.${item.minor}`;
  const compatibilityLine = line(versions[0]);
  if (versions.some((item) => line(item) !== compatibilityLine))
    throw new Error('Public packages must share major.minor');
  const byName = new Map(manifests.map((item) => [item.name, item]));
  for (const manifest of manifests) {
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!dependency.startsWith('@borecount/')) continue;
      const target = byName.get(dependency);
      if (!target) throw new Error(`Unknown internal package: ${dependency}`);
      if (!/^[~^]/.test(range))
        throw new Error(
          `${manifest.name} needs an explicit compatible patch range for ${dependency}`,
        );
      const minimum = version(range.slice(1));
      const targetVersion = version(target.version);
      // Caret ranges stay inside one minor only for 0.<nonzero> releases.
      const bounded = range[0] === '~' || (minimum.major === 0 && minimum.minor > 0);
      if (!bounded || line(minimum) !== compatibilityLine || compare(minimum, targetVersion) > 0) {
        throw new Error(
          `${manifest.name} has an incompatible minimum patch range for ${dependency}: ${range}`,
        );
      }
    }
  }
  const openApiSource = await readFile(join(root, 'packages/http/openapi/openapi.yaml'), 'utf8');
  const contractVersion = openApiSource.match(
    /^info:\n(?:[ \t].*\n)*?[ \t]+version:[ \t]*([^\s#]+)[ \t]*$/m,
  )?.[1];
  const httpVersion = byName.get('@borecount/http')?.version;
  if (contractVersion !== httpVersion)
    throw new Error(
      `OpenAPI version ${contractVersion} must match HTTP package version ${httpVersion}`,
    );
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  const packages: PackageRelease[] = [];
  for (const [index, manifest] of manifests.entries()) {
    const directory = PUBLIC_PACKAGES[index];
    const specific = `docs/releases/${directory}-${manifest.version}.md`;
    const legacy = `docs/releases/${manifest.version}.md`;
    const specificNotes = await readFile(join(root, specific), 'utf8').catch(() => null);
    const notes = specificNotes ?? (await readFile(join(root, legacy), 'utf8').catch(() => null));
    if (!notes?.includes(`\`${manifest.name}\` | \`${manifest.version}\``)) {
      throw new Error(`Release notes do not declare ${manifest.name}@${manifest.version}`);
    }
    const heading = specificNotes !== null ? `${directory}@${manifest.version}` : manifest.version;
    if (!changelog.includes(`## [${heading}]`))
      throw new Error(`CHANGELOG.md does not contain a ${heading} release heading`);
    packages.push({
      name: manifest.name,
      directory,
      version: manifest.version,
      tarball: `borecount-${directory}-${manifest.version}.tgz`,
      notes: specificNotes !== null ? specific : legacy,
      gitTag: specificNotes !== null ? `${directory}-v${manifest.version}` : `v${manifest.version}`,
    });
  }
  const idempotency = await readFile(join(root, 'docs/integration/idempotency.md'), 'utf8');
  for (const operation of stateChangingOperations(openApiSource)) {
    if (!idempotency.includes(`\`${operation}\``))
      throw new Error(`Idempotency reference does not cover ${operation}`);
  }
  return { compatibilityLine, contractVersion: httpVersion as string, packages };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { manifest: { type: 'string' } } });
  const release = await verifyReleaseReadiness(process.cwd());
  if (values.manifest) {
    await mkdir(dirname(values.manifest), { recursive: true });
    await writeFile(values.manifest, `${JSON.stringify(release, null, 2)}\n`);
  }
  console.log(
    `Release checks passed for ${release.compatibilityLine}.x: ${release.packages.map((item) => `${item.name}@${item.version}`).join(', ')}`,
  );
}
