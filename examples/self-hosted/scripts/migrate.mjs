/**
 * Runs the example's controlled package-migration release step.
 * Uses the separate migration login, checks applied SQL hashes/timestamps against the
 * pinned release and serializes migration runs before applying pending migrations.
 * Security-overlay installation remains a separate administrator operation.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { borecountMigrationsPath } from '@borecount/postgres-adapter/migrations';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

export async function migrateSelfHosted(databaseUrl) {
  if (!databaseUrl) throw new Error('Migration connection required');
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const folder = borecountMigrationsPath;
  const connection = client;
  try {
    const [identity] = await connection`select current_user as role, rolsuper, rolbypassrls
      from pg_roles where rolname = current_user`;
    if (identity.role !== 'ledger_migrator' || identity.rolsuper || identity.rolbypassrls) {
      throw new Error('Use the separate ledger_migrator login');
    }
    await connection`select pg_advisory_lock(132080)`;
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
    const expected = await Promise.all(journal.entries.map(async entry => ({
      hash: createHash('sha256').update(await readFile(join(folder, `${entry.tag}.sql`))).digest('hex'),
      created_at: String(entry.when),
    })));
    const [exists] = await connection`select to_regclass('drizzle.__drizzle_migrations') is not null as value`;
    if (exists.value) {
      const [inventory] = await connection`select count(*)::int as count from pg_tables where schemaname = 'public'`;
      if (inventory.count !== 19) throw new Error('This release supports only the package-owned schema');
      const rows = await connection`select hash, created_at::text from drizzle.__drizzle_migrations order by created_at, id`;
      if (rows.length > expected.length || rows.some((row, i) => row.hash !== expected[i].hash || row.created_at !== expected[i].created_at)) {
        throw new Error('Incompatible migration history; keep traffic stopped and review recovery');
      }
    } else {
      const [tables] = await connection`select count(*)::int as count from pg_tables where schemaname = 'public'`;
      if (tables.count !== 0) throw new Error('Refusing to adopt a database without known migration history');
    }
    await migrate(drizzle(connection), { migrationsFolder: folder });
  } finally {
    await connection`select pg_advisory_unlock(132080)`.catch(() => {});
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(process.env.SELF_HOST_OPERATOR_CONFIG, 'utf8'));
    await migrateSelfHosted(config.MIGRATION_DATABASE_URL);
    console.log('Self-hosted package migrations verified and applied');
  } catch {
    console.error('Self-hosted migration rejected; check target, role and release history');
    process.exitCode = 1;
  }
}
