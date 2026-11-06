import { afterAll, beforeAll, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApiKeyRole } from '@borecount/core';
import { generateApiKey } from '@borecount/core/application';
import { generateUuidV7, TenantId } from '@borecount/core/base';
import { sql } from 'drizzle-orm';
import { createApplicationServices } from '../../src/application-services';
import { createDbClient, type DbClient } from '../../src/client';
import { assets } from '../../src/schema';
import { createTenantProvisioningService } from '../../src/tenant-provisioning';
import { createUnitOfWork } from '../../src/unit-of-work';
import {
  createRepositoryTestClient,
  createRepositoryTestDatabase,
  databaseUrl,
  migrateTestDatabase,
} from './repository-test-support';

const admin = createRepositoryTestClient();
const db = createRepositoryTestDatabase(admin);
const groups = [
  'borecount_runtime',
  'borecount_authenticator',
  'borecount_credential_owner',
  'borecount_operator',
];
const logins = ['ll136_runtime', 'll136_auth', 'll136_operator', 'll136_migrator'];
const clients: DbClient[] = [];
let installed = false;
let runtime: DbClient;
let lookup: DbClient;
let operator: DbClient;
let overlay: string;

const tableNames = [
  'tenants',
  'api_keys',
  'assets',
  'ledgers',
  'accounts',
  'transactions',
  'entries',
  'holds',
  'hold_entries',
  'credit_grants',
  'credit_grant_entries',
  'credit_grant_hold_allocations',
  'credit_grant_capacity_versions',
  'balance_snapshots',
  'recon_uploads',
  'recon_records',
  'recon_rules',
  'recon_runs',
  'recon_results',
];

beforeAll(async () => {
  // Cluster-wide fixture roles must never collide with an existing deployment.
  const existing =
    await admin.sql`select rolname from pg_roles where rolname in ${admin.sql([...groups, ...logins])}`;
  if (existing.length)
    throw new Error('Security fixture roles already exist; use a dedicated disposable cluster');
  await migrateTestDatabase(db);
  overlay = await readFile('examples/security/least-privilege.sql', 'utf8');
  await admin.sql.begin(async (tx) => {
    await tx.unsafe(overlay);
    for (const [index, login] of logins.entries()) {
      const password = randomBytes(24).toString('hex');
      await tx.unsafe(
        `CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
      );
      if (index < 3) await tx.unsafe(`GRANT ${groups[index === 2 ? 3 : index]} TO ${login}`);
      const url = new URL(databaseUrl);
      url.username = login;
      url.password = password;
      clients.push(createDbClient({ databaseUrl: url.toString(), max: index === 0 ? 2 : 1 }));
    }
    // Separate migration ownership, not inherited by any request/lookup login.
    await tx.unsafe('GRANT USAGE, CREATE ON SCHEMA public TO ll136_migrator');
    for (const table of tableNames)
      await tx.unsafe(`ALTER TABLE public.${table} OWNER TO ll136_migrator`);
  });
  installed = true;
  [runtime, lookup, operator] = clients;
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.sql.end({ timeout: 5 })));
  if (installed) {
    await admin.sql.begin(async (tx) => {
      const [row] = await tx.unsafe('select current_user as owner');
      const owner = String(row.owner).replaceAll('"', '""');
      await tx.unsafe(`REASSIGN OWNED BY ll136_migrator TO "${owner}"`);
      await tx.unsafe('DROP SCHEMA borecount_security CASCADE');
      for (const role of [...logins, ...groups]) {
        await tx.unsafe(`DROP OWNED BY ${role}`);
        await tx.unsafe(`DROP ROLE ${role}`);
      }
    });
  }
  await admin.sql.end({ timeout: 5 });
});

const fixture = async () => {
  const tenantId = generateUuidV7(new Date());
  const rawApiKey = generateApiKey();
  const provisioner = createTenantProvisioningService(operator);
  const command = {
    tenantId,
    tenantName: 'Security tenant',
    keyName: 'Admin',
    role: ApiKeyRole.ADMIN,
    rawApiKey,
  };
  const provisioned = await provisioner.provisionTenant(command);
  expect((await provisioner.provisionTenant(command)).created).toBe(false);
  const services = createApplicationServices(runtime, lookup);
  await runtime.runTenantTx(tenantId, 'create asset fixture', (tx) =>
    tx.insert(assets).values({ tenantId, code: 'USD', scale: 2 }),
  );
  const ledger = await services.ledgers.create({ tenantId, name: 'Ledger' });
  const wallet = await services.accounts.create({
    tenantId,
    ledgerId: ledger.id,
    name: 'Wallet',
    currency: 'USD',
    side: 'CREDIT',
    overdraftPolicy: 'DISALLOW',
    grantEnabled: true,
  });
  const funding = await services.accounts.create({
    tenantId,
    ledgerId: ledger.id,
    name: 'Funding',
    currency: 'USD',
    side: 'DEBIT',
  });
  const { grant } = await services.creditGrants.create({
    tenantId,
    ledgerId: ledger.id,
    accountId: wallet.id,
    fundingAccountId: funding.id,
    reference: 'grant',
    amountMinor: 100n,
  });
  const request = {
    tenantId,
    ledgerId: ledger.id,
    currency: 'USD',
    reference: 'hold',
    entries: [
      { accountId: wallet.id, currency: 'USD', signedAmountMinor: 20n },
      { accountId: funding.id, currency: 'USD', signedAmountMinor: -20n },
    ],
  };
  const hold = await services.holds.create(request);
  const rule = await services.reconciliation.createRule({
    tenantId,
    name: 'Reference',
    criteria: [{ field: 'reference', operator: 'equals' }],
  });
  const upload = await services.reconciliation.ingest({
    tenantId,
    source: 'security fixture',
    records: [
      {
        externalId: '1',
        amountMinor: 100n,
        currency: 'USD',
        reference: 'grant',
        occurredAt: new Date(),
      },
    ],
  });
  await services.reconciliation.run({
    tenantId,
    ledgerId: ledger.id,
    uploadId: upload.id,
    strategy: 'one_to_one',
    matchingRuleIds: [rule.id],
  });
  return {
    tenantId,
    rawApiKey,
    key: provisioned.key,
    ledger,
    wallet,
    funding,
    grant,
    hold,
    request,
    services,
  };
};

it('runs all data families as a real non-owner login, isolates raw SQL and rejects foreign writes', async () => {
  const provisioner = createTenantProvisioningService(operator);
  const bootstrap = {
    tenantName: 'Bootstrap',
    keyName: 'Bootstrap admin',
    rawApiKey: generateApiKey(),
  };
  expect(await provisioner.bootstrapInitialAdmin(bootstrap)).not.toBeNull();
  expect(await provisioner.bootstrapInitialAdmin(bootstrap)).toBeNull();
  const own = await fixture();
  const foreign = await fixture();
  await own.services.holds.commit({
    tenantId: own.tenantId,
    holdId: own.hold.holdId,
    reference: 'capture',
    amountMinor: 10n,
  });
  await own.services.holds.void({ tenantId: own.tenantId, holdId: own.hold.holdId });
  await own.services.creditGrants.refund({
    tenantId: own.tenantId,
    grantId: own.grant.id,
    reference: 'refund',
    amountMinor: 5n,
  });
  const [role] = await runtime.sql`select current_user as name, rolsuper, rolbypassrls,
    pg_has_role(current_user, 'll136_migrator', 'MEMBER') as migrator,
    pg_has_role(current_user, 'borecount_operator', 'MEMBER') as operator
    from pg_roles where rolname = current_user`;
  expect(role).toMatchObject({
    name: 'll136_runtime',
    rolsuper: false,
    rolbypassrls: false,
    migrator: false,
    operator: false,
  });
  for (const privileged of [
    'll136_migrator',
    'borecount_operator',
    'borecount_authenticator',
    'borecount_credential_owner',
  ]) {
    await expect(
      Promise.resolve(runtime.sql.unsafe(`set role ${privileged}`)),
    ).rejects.toMatchObject({ code: '42501' });
  }
  await expect(
    Promise.resolve(runtime.sql`create table public.forbidden(id int)`),
  ).rejects.toMatchObject({
    code: '42501',
  });
  await runtime.runTenantTx(own.tenantId, 'probe all tenant tables', async (tx) => {
    for (const table of tableNames) {
      const tenantColumn = table === 'tenants' ? 'id' : 'tenant_id';
      const rows = await tx.execute<{ tenant: string }>(
        sql`select ${sql.identifier(tenantColumn)} as tenant from ${sql.identifier(table)}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.tenant === own.tenantId)).toBe(true);
    }
    await expect(
      tx.transaction(async (nested) => {
        await nested.execute(
          sql`insert into ledgers(tenant_id, name) values (${foreign.tenantId}, 'spoof')`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const changed = await tx.execute(
      sql`update accounts set balance_minor = 999 where tenant_id = ${foreign.tenantId} returning id`,
    );
    expect(changed.length).toBe(0);
  });
  await expect(
    own.services.accounts.getById(own.tenantId, foreign.wallet.id),
  ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  const apiKeys = own.services.apiKeys;
  await expect(apiKeys.authenticate(generateApiKey())).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  const auth = await apiKeys.authenticate(own.rawApiKey);
  expect(auth.tenantId).toBe(own.tenantId);
  await apiKeys.assertAccessTokenIsActive(auth);
  await expect(apiKeys.revokeApiKey(auth, foreign.key.id)).rejects.toThrow('API key not found');
  expect((await apiKeys.authenticate(foreign.rawApiKey)).tenantId).toBe(foreign.tenantId);
  const service = await apiKeys.createApiKey(auth, {
    tenantId: own.tenantId,
    name: 'Service',
    role: ApiKeyRole.SERVICE,
  });
  await expect(
    apiKeys.listApiKeys(await apiKeys.authenticate(service.apiKey), { limit: 10 }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await apiKeys.revokeApiKey(auth, own.key.id);
  await expect(apiKeys.authenticate(own.rawApiKey)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(apiKeys.assertAccessTokenIsActive(auth)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  await expect(Promise.resolve(lookup.sql`select * from public.api_keys`)).rejects.toMatchObject({
    code: '42501',
  });
  await expect(Promise.resolve(lookup.sql`select * from public.accounts`)).rejects.toMatchObject({
    code: '42501',
  });
  await expect(
    Promise.resolve(
      runtime.sql`select * from borecount_security.find_api_key(${foreign.key.id}::uuid)`,
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('clears context after commit/rollback, separates simultaneous tenants and preserves atomic retries', async () => {
  const own = await fixture();
  const foreign = await fixture();
  for (const rollback of [false, true]) {
    const action = runtime.runTenantTx(own.tenantId, 'context rollback probe', async (tx) => {
      await tx.execute(
        sql`insert into ledgers(tenant_id, name) values (${own.tenantId}, 'rollback probe')`,
      );
      if (rollback) throw new Error('intentional rollback');
    });
    if (rollback)
      await expect(action).rejects.toMatchObject({ cause: { message: 'intentional rollback' } });
    else await action;
    for (const table of tableNames)
      expect(await runtime.sql.unsafe(`select * from ${table}`)).toHaveLength(0);
  }
  const lists = await Promise.all([
    own.services.ledgers.list({ tenantId: own.tenantId, limit: 50 }),
    foreign.services.ledgers.list({ tenantId: foreign.tenantId, limit: 50 }),
  ]);
  expect(lists[0].data.every((ledger) => ledger.tenantId === own.tenantId)).toBe(true);
  expect(lists[1].data.every((ledger) => ledger.tenantId === foreign.tenantId)).toBe(true);
  const command = {
    tenantId: own.tenantId,
    ledgerId: own.ledger.id,
    reference: 'retry',
    currency: 'USD',
    entries: [
      { accountId: own.funding.id, currency: 'USD', signedAmountMinor: 1n },
      { accountId: own.wallet.id, currency: 'USD', signedAmountMinor: -1n },
    ],
  };
  // A grant-enabled credit requires grant issuance, so use a normal counter-account here.
  const counter = await own.services.accounts.create({
    tenantId: own.tenantId,
    ledgerId: own.ledger.id,
    name: 'Counter',
    currency: 'USD',
    side: 'CREDIT',
  });
  command.entries[1].accountId = counter.id;
  const first = await own.services.transactions.create(command);
  expect((await own.services.transactions.create(command)).transactionId).toBe(first.transactionId);
  await expect(
    own.services.transactions.create({ ...command, description: 'conflict' }),
  ).rejects.toThrow();
  await runtime.runTenantTx(own.tenantId, 'verify immutable ordinary transaction', async (tx) => {
    const [before] = await tx.execute(
      sql`select * from transactions where id = ${first.transactionId}`,
    );
    await expect(
      tx.transaction(async (nested) => {
        await nested.execute(
          sql`update transactions set id = ${generateUuidV7(new Date())} where id = ${first.transactionId}`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      tx.transaction(async (nested) => {
        await nested.execute(
          sql`update transactions set metadata = '{"tampered":true}'::jsonb where id = ${first.transactionId}`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: 'P0001' } });
    const [after] = await tx.execute(
      sql`select * from transactions where id = ${first.transactionId}`,
    );
    expect(after).toEqual(before);
    const entries = await tx.execute(
      sql`select id from entries where transaction_id = ${first.transactionId}`,
    );
    expect(entries).toHaveLength(2);
  });
  await own.services.transactions.reverse({
    tenantId: own.tenantId,
    transactionId: first.transactionId,
    reference: 'reverse',
  });
  await expect(
    createUnitOfWork(runtime).run(new TenantId(own.tenantId), async ({ services }) => {
      await services.ledgers.create({ tenantId: own.tenantId, name: 'must roll back' });
      await services.ledgers.create({ tenantId: foreign.tenantId, name: 'mismatch' });
    }),
  ).rejects.toThrow('Unit of work tenant does not match operation tenant');
  expect(
    (await own.services.ledgers.list({ tenantId: own.tenantId, limit: 50 })).data.some(
      (ledger) => ledger.name === 'must roll back',
    ),
  ).toBe(false);
});

it('reapplies without broadening access and keeps lookup ownership non-login', async () => {
  await admin.sql.begin(async (tx) => {
    await tx.unsafe(overlay);
  });
  const [owner] =
    await admin.sql`select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'borecount_credential_owner'`;
  expect(owner).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
  await expect(
    Promise.resolve(lookup.sql`set role borecount_credential_owner`),
  ).rejects.toMatchObject({
    code: '42501',
  });
});

it('rejects unsafe inherited runtime capabilities when reapplying the deployment baseline', async () => {
  for (const grant of [
    'GRANT borecount_authenticator TO ll136_runtime',
    'GRANT CREATE ON SCHEMA public TO ll136_runtime',
    'GRANT TRUNCATE ON public.accounts TO ll136_runtime',
    'GRANT UPDATE (role) ON public.api_keys TO ll136_runtime',
    'GRANT EXECUTE ON FUNCTION borecount_security.find_api_key(uuid) TO ll136_runtime',
    'GRANT borecount_credential_owner TO ll136_auth',
  ]) {
    await expect(
      admin.sql.begin(async (tx) => {
        await tx.unsafe(grant);
        await tx.unsafe(overlay);
      }),
    ).rejects.toMatchObject({ code: 'P0001' });
  }
  const migration = clients[3];
  const [role] =
    await migration.sql`select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  expect(role).toMatchObject({ name: 'll136_migrator', rolsuper: false, rolbypassrls: false });
  await migration.sql`create table public.ll136_migration_probe(id int)`;
  await migration.sql`drop table public.ll136_migration_probe`;
});

it('rejects BYPASSRLS and destructive privileges reachable only through SET ROLE', async () => {
  for (const bypass of [true, false]) {
    await expect(
      admin.sql.begin(async (tx) => {
        await tx.unsafe(
          `CREATE ROLE ll136_alternate NOLOGIN ${bypass ? 'BYPASSRLS' : 'NOBYPASSRLS'}`,
        );
        await tx.unsafe(
          `GRANT ${bypass ? 'SELECT' : 'TRUNCATE'} ON public.accounts TO ll136_alternate`,
        );
        await tx.unsafe('GRANT USAGE ON SCHEMA public TO ll136_alternate');
        await tx.unsafe('GRANT ll136_alternate TO ll136_runtime WITH INHERIT FALSE, SET TRUE');
        const [capabilities] = await tx.unsafe(`select
        pg_has_role('ll136_runtime', 'll136_alternate', 'SET') as can_set,
        pg_has_role('ll136_runtime', 'll136_alternate', 'USAGE') as inherits`);
        expect(capabilities).toMatchObject({ can_set: true, inherits: false });
        // No inherited table privileges or runtime role attributes reveal this capability.
        await tx.unsafe(overlay);
      }),
    ).rejects.toMatchObject({ code: 'P0001' });
  }
});

it('keeps API-key reads and writes in the tenant unit-of-work transaction under split roles', async () => {
  const own = await fixture();
  const foreign = await fixture();
  const rollback = new Error('rollback credential changes');
  let createdRawKey: string | undefined;
  await expect(
    createUnitOfWork(runtime).run(new TenantId(own.tenantId), async ({ services }) => {
      const auth = await services.apiKeys.authenticate(own.rawApiKey);
      expect(auth.tenantId).toBe(own.tenantId);
      await services.apiKeys.assertAccessTokenIsActive(auth);
      await expect(services.apiKeys.authenticate(foreign.rawApiKey)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      const created = await services.apiKeys.createApiKey(auth, {
        tenantId: own.tenantId,
        name: 'Transactional key',
        role: ApiKeyRole.SERVICE,
      });
      createdRawKey = created.apiKey;
      const createdAuth = await services.apiKeys.authenticate(created.apiKey);
      expect(createdAuth.apiKeyId).toBe(created.key.id);
      await services.apiKeys.revokeApiKey(auth, own.key.id);
      await expect(services.apiKeys.authenticate(own.rawApiKey)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(services.apiKeys.assertAccessTokenIsActive(auth)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect((await own.services.apiKeys.authenticate(own.rawApiKey)).tenantId).toBe(own.tenantId);
  expect(createdRawKey).toBeDefined();
  await expect(own.services.apiKeys.authenticate(createdRawKey!)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});
