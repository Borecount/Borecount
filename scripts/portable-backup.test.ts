import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtures: string[] = [];
const contentCanary = 'MIGRATION_CONTENT_MUST_REMAIN_PRIVATE';
const environmentCanary = 'MIGRATION_ENVIRONMENT_MUST_REMAIN_PRIVATE';
const entry = { idx: 0, when: 1, tag: '0000_host', version: '7', breakpoints: true };

async function fixture(journal?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'borecount-migration-input-'));
  fixtures.push(directory);
  await mkdir(join(directory, 'meta'));
  if (journal !== undefined) await writeFile(join(directory, 'meta/_journal.json'), journal);
  return directory;
}

const validJournal = () => JSON.stringify({ dialect: 'postgresql', entries: [entry] });

async function reject(directory: string, reason: string, path: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      join(import.meta.dir, 'portable-backup.ts'),
      'backup',
      '--source',
      'unused',
      '--host-migrations',
      directory,
      join(directory, 'bundle'),
    ],
    {
      env: { ...process.env, PATH: '', PGPASSWORD: environmentCanary },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('Rejected:');
  expect(stderr).toContain(reason);
  expect(stderr).toContain(JSON.stringify(path));
  expect(stderr).not.toContain(contentCanary);
  expect(stderr).not.toContain(environmentCanary);
  expect(stderr).not.toContain('missing tool');
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('portable backup migration input diagnostics', () => {
  it('identifies a missing journal without requiring PostgreSQL tools', async () => {
    const directory = await fixture();
    await reject(directory, 'file not found', join(directory, 'meta/_journal.json'));
  });

  it('identifies missing SQL without exposing the journal contents', async () => {
    const directory = await fixture(validJournal());
    await reject(directory, 'file not found', join(directory, `${entry.tag}.sql`));
  });

  it('reports invalid JSON without echoing JSON parser excerpts', async () => {
    const directory = await fixture(`{"private":"${contentCanary}", invalid`);
    await reject(directory, 'invalid JSON', join(directory, 'meta/_journal.json'));
  });

  it.each([
    { journal: null },
    { journal: [] },
    { journal: { dialect: 'postgresql', entries: contentCanary } },
  ])('identifies malformed journal structure', async ({ journal }) => {
    const directory = await fixture(JSON.stringify(journal));
    await reject(
      directory,
      'invalid Drizzle journal structure',
      join(directory, 'meta/_journal.json'),
    );
  });

  it('identifies invalid entries without echoing their contents', async () => {
    const directory = await fixture(
      JSON.stringify({
        dialect: 'postgresql',
        entries: [{ ...entry, tag: `../${contentCanary}` }],
      }),
    );
    await reject(directory, 'unique safe migration tags', join(directory, 'meta/_journal.json'));
  });

  it.skipIf(process.getuid?.() === 0 || process.getuid === undefined)(
    'identifies denied journal and SQL access without leaking file contents',
    async () => {
      const directory = await fixture(validJournal());
      const journalPath = join(directory, 'meta/_journal.json');
      await chmod(journalPath, 0o000);
      try {
        await reject(directory, 'permission denied', journalPath);
      } finally {
        await chmod(journalPath, 0o600);
      }
      const sqlPath = join(directory, `${entry.tag}.sql`);
      await writeFile(sqlPath, contentCanary);
      await chmod(sqlPath, 0o000);
      try {
        await reject(directory, 'permission denied', sqlPath);
      } finally {
        await chmod(sqlPath, 0o600);
      }
    },
  );
});
