import { afterAll, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import {
  createRepositoryTestClient,
  createRepositoryTestDatabase,
  migrateTestDatabase,
} from './repository-test-support';

const client = createRepositoryTestClient();
const db = createRepositoryTestDatabase(client);
afterAll(() => client.sql.end({ timeout: 5 }));

it('rolls back the baseline DDL when its transaction aborts', async () => {
  const [baseline] = readMigrationFiles({ migrationsFolder: 'drizzle' });
  try {
    await db.execute(sql`DROP SCHEMA public CASCADE`);
    await db.execute(sql`CREATE SCHEMA public`);

    await expect(
      db.transaction(async (tx) => {
        for (const statement of baseline.sql) {
          await tx.execute(sql.raw(statement));
        }
        throw new Error('abort baseline');
      }),
    ).rejects.toThrow('abort baseline');

    const [rolledBack] = await db.execute(sql`
      select to_regclass('public.credit_grant_hold_allocations') as allocations,
             to_regprocedure('public.uuid_v7()') as uuid_generator
    `);
    expect(rolledBack.allocations).toBeNull();
    expect(rolledBack.uuid_generator).toBeNull();
  } finally {
    await migrateTestDatabase(db);
  }
});

it('installs signed amount guards and the tenant grant-list index', async () => {
  const constraints = await db.execute(sql`
    select conname from pg_constraint
    where (conrelid, conname) in (
      ('public.entries'::regclass, 'entries_signed_amount_nonzero_chk'),
      ('public.hold_entries'::regclass, 'hold_entries_signed_amount_nonzero_chk'),
      ('public.accounts'::regclass, 'accounts_reserved_delta_side_chk')
    )
  `);
  expect(constraints).toHaveLength(3);

  const [index] = await db.execute(sql`
    select indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'credit_grants'
      and indexname = 'credit_grants_tenant_created_id_idx'
  `);
  expect(index?.indexdef).toContain('(tenant_id, created_at, id)');
});
