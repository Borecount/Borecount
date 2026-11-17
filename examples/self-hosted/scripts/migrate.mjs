/**
 * Runs the example's controlled package-migration release step.
 * Uses the separate migration login, checks applied SQL hashes/timestamps against the
 * pinned release and serializes migration runs before applying pending migrations.
 * Security-overlay installation remains a separate administrator operation.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { borecountMigrationsPath } from '@borecount/postgres-adapter/migrations';
import { parseDatabaseUrl } from '../src/database-policy.mjs';
import { verifyReleaseState } from '../src/release-state.mjs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

export async function migrateSelfHosted(databaseUrl) {
  const target = parseDatabaseUrl(databaseUrl);
  const client = postgres(target.href, { max: 1, onnotice: () => {} });
  const folder = borecountMigrationsPath;
  const connection = client;
  try {
    const [identity] = await connection`select current_user as role, rolsuper, rolbypassrls
      from pg_roles where rolname = current_user`;
    if (identity.role !== 'ledger_migrator' || identity.rolsuper || identity.rolbypassrls) {
      throw new Error('Use the separate ledger_migrator login');
    }
    await connection`select pg_advisory_lock(132080)`;
    await verifyReleaseState(connection, { allowPending: true });
    await migrate(drizzle(connection), { migrationsFolder: folder });
    await verifyReleaseState(connection);
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
