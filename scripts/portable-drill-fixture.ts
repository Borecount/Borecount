import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  createApplicationServices,
  createDbClient,
  DrizzleTenantRepository,
} from '@borecount/postgres-adapter';

const action = process.argv[2];
const database = action === 'seed' ? 'drill_source' : 'drill_recovery';
const socket = process.env.PGHOST ?? '';
assert.ok(
  (action === 'seed' || action === 'replay') &&
    process.env.DATABASE_URL === `postgresql:///${database}` &&
    /^bc-drill-[a-z0-9_]+$/.test(basename(dirname(socket))) &&
    basename(socket) === (action === 'seed' ? 'src' : 'dst') &&
    (statSync(socket).mode & 0o777) === 0o700,
  'Run this fixture through portable-drill.py',
);
const client = createDbClient({ max: 1 });
const services = createApplicationServices(client);
const tenants = new DrizzleTenantRepository(client);
const reference = 'portable-drill-posting';

const posting = (tenantId: string, ledgerId: string, cash: string, revenue: string) => ({
  tenantId,
  ledgerId,
  reference,
  currency: 'USD',
  metadata: { origin: 'portable-drill' },
  entries: [
    { accountId: cash, currency: 'USD', signedAmountMinor: 125n },
    { accountId: revenue, currency: 'USD', signedAmountMinor: -125n },
  ],
});

async function seed() {
  for (const name of ['Drill tenant A', 'Drill tenant B']) {
    const { id: tenantId } = await tenants.create({ name });
    const { id: ledgerId } = await services.ledgers.create({ tenantId, name: 'Drill ledger' });
    const { id: assetId } = await services.assets.create({ tenantId, code: 'USD', scale: 2 });
    const account = { tenantId, ledgerId, assetId, currency: 'USD' };
    const cash = await services.accounts.create({ ...account, name: 'Cash', side: 'DEBIT' });
    const revenue = await services.accounts.create({ ...account, name: 'Revenue', side: 'CREDIT' });
    const wallet = await services.accounts.create({
      ...account,
      name: 'Wallet',
      side: 'CREDIT',
      overdraftPolicy: 'DISALLOW',
      grantEnabled: true,
    });
    const request = posting(tenantId, ledgerId, cash.id, revenue.id);
    assert.equal((await services.transactions.create(request)).created, true);
    await services.creditGrants.create({
      tenantId,
      ledgerId,
      accountId: wallet.id,
      fundingAccountId: cash.id,
      reference: 'portable-drill-grant',
      amountMinor: 100n,
    });
  }
}

async function replay() {
  const rows = await client.sql<
    { id: string; tenant_id: string; ledger_id: string; cash: string; revenue: string }[]
  >`
    SELECT t.id, t.tenant_id, t.ledger_id, cash.id AS cash, revenue.id AS revenue
    FROM transactions t
    JOIN accounts cash ON cash.ledger_id = t.ledger_id AND cash.name = 'Cash'
    JOIN accounts revenue ON revenue.ledger_id = t.ledger_id AND revenue.name = 'Revenue'
    WHERE t.reference = ${reference}
  `;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].tenant_id, rows[1].tenant_id);
  // The isolated fixture uses a single connection, then assumes the real deployment role.
  await client.sql`SET ROLE borecount_runtime`;
  for (const row of rows) {
    const request = posting(row.tenant_id, row.ledger_id, row.cash, row.revenue);
    const retry = await services.transactions.create(request);
    assert.equal(retry.created, false);
    assert.equal(retry.transactionId, row.id);
    await assert.rejects(
      services.transactions.create({ ...request, description: 'conflicting retry' }),
      /reference payload mismatch/,
    );
  }
}

try {
  const [connection] = await client.sql`
    SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses') = ''
      AND current_setting('unix_socket_directories') = ${socket}
      AND current_database() = ${database} AS isolated
  `;
  assert.equal(connection?.isolated, true);
  if (action === 'seed') await seed();
  else await replay();
  console.log('Drill fixture passed.');
} catch {
  console.error('Drill fixture failed.');
  process.exitCode = 1;
} finally {
  await client.sql.end({ timeout: 5 });
}
