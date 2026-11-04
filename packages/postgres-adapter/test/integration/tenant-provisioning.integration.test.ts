import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ApiKeyRole } from '@borecount/core';
import {
  ForbiddenError,
  generateApiKey,
  InvariantViolationError,
} from '@borecount/core/application';
import { TenantId } from '@borecount/core/base';
import {
  apiKeys,
  createApiKeyService,
  createDbClient,
  createTenantProvisioningService,
  createUnitOfWork,
  type DbClient,
  tenants,
} from '@borecount/postgres-adapter';
import { eq, sql } from 'drizzle-orm';
import {
  createRepositoryTestClient,
  createRepositoryTestDatabase,
  databaseUrl,
  migrateTestDatabase,
  truncateTestDatabase,
} from './repository-test-support';

const client = createRepositoryTestClient();
const db = createRepositoryTestDatabase(client);
const unitOfWork = createUnitOfWork(client);
const apiKeyService = createApiKeyService(client);
const provisioner = createTenantProvisioningService(client);

const input = (
  tenantId: string,
  overrides: Partial<{
    tenantName: string;
    keyName: string;
    role: typeof ApiKeyRole.ADMIN | typeof ApiKeyRole.SERVICE;
    rawApiKey: string;
  }> = {},
) => ({
  tenantId,
  tenantName: 'Provisioned Tenant',
  keyName: 'Initial admin',
  role: ApiKeyRole.ADMIN,
  rawApiKey: generateApiKey(),
  ...overrides,
});

const runProvisioning = async (request: ReturnType<typeof input>) =>
  unitOfWork.run(new TenantId(request.tenantId), ({ provisioning }) =>
    provisioning.provisionTenant(request),
  );

const findTenant = async (tenantId: string) => {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return tenant ?? null;
};

const waitForBootstrapLockWaiter = async (client: DbClient): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await client.runTx('check bootstrap lock waiter', async (tx) => {
      const rows = await tx.execute(sql<{ waiting: boolean }>`
        select exists (
          select 1 from pg_locks
          where locktype = 'advisory' and mode = 'ExclusiveLock' and not granted
        ) as waiting
      `);
      return rows[0]?.waiting ?? false;
    });
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Bootstrap did not wait for the provisioning transaction lock');
};

const runBootstrapProvisioningRace = async (rollback: boolean) => {
  const raceClient = createDbClient({ databaseUrl, max: 3 });
  const raceUnitOfWork = createUnitOfWork(raceClient);
  const raceProvisioner = createTenantProvisioningService(raceClient);
  const request = input(
    rollback ? '12121212-1212-4121-8121-121212121212' : '13131313-1313-4131-8131-131313131313',
  );
  let signalProvisioned!: () => void;
  let releaseProvisioning!: () => void;
  const provisioned = new Promise<void>((resolve) => {
    signalProvisioned = resolve;
  });
  const holdTransaction = new Promise<void>((resolve) => {
    releaseProvisioning = resolve;
  });
  const provisioning = raceUnitOfWork.run(
    new TenantId(request.tenantId),
    async ({ provisioning: service }) => {
      const result = await service.provisionTenant(request);
      signalProvisioned();
      await holdTransaction;
      if (rollback) throw new Error('rollback provisioning after coordinated wait');
      return result;
    },
  );

  let bootstrap: ReturnType<typeof raceProvisioner.bootstrapInitialAdmin> | undefined;
  let waitFailed = false;
  let waitError: unknown;
  try {
    await Promise.race([
      provisioned,
      provisioning.then(() => {
        throw new Error('Provisioning completed before reaching the transaction barrier');
      }),
    ]);
    bootstrap = raceProvisioner.bootstrapInitialAdmin({
      tenantName: 'Concurrent bootstrap',
      keyName: 'Concurrent bootstrap admin',
      rawApiKey: generateApiKey(),
    });
    await waitForBootstrapLockWaiter(raceClient);
  } catch (error) {
    waitFailed = true;
    waitError = error;
  } finally {
    releaseProvisioning();
  }

  const [provisioningResult] = await Promise.allSettled([provisioning]);
  const bootstrapResult = bootstrap ? (await Promise.allSettled([bootstrap]))[0] : undefined;
  await raceClient.sql.end({ timeout: 5 });
  if (waitFailed) throw waitError;
  if (!bootstrapResult) throw new Error('Bootstrap did not start');
  return { provisioningResult, bootstrapResult, request };
};

describe('tenant provisioning integration', () => {
  beforeAll(() => migrateTestDatabase(db));
  beforeEach(() => truncateTestDatabase(db));
  afterAll(() => client.sql.end({ timeout: 5 }));

  it.each([
    ApiKeyRole.ADMIN,
    ApiKeyRole.SERVICE,
  ])('provisions a %s credential atomically', async (role) => {
    const request = input('11111111-1111-4111-8111-111111111111', { role });

    const result = await runProvisioning(request);

    expect(result.created).toBe(true);
    expect(result.key.tenantId).toBe(request.tenantId);
    expect(result.key.role).toBe(role);
    expect(result.key.keyHash).not.toBe(request.rawApiKey);
    expect(await findTenant(request.tenantId)).toMatchObject({ name: request.tenantName });
    expect(
      await db.select().from(apiKeys).where(eq(apiKeys.tenantId, request.tenantId)),
    ).toHaveLength(1);
  });

  it('supports exact retries and rejects changed name, role, or credential without adding keys', async () => {
    const request = input('22222222-2222-4222-8222-222222222222');
    const first = await runProvisioning(request);
    const retry = await runProvisioning(request);

    expect(retry.created).toBe(false);
    expect(retry.key.id).toBe(first.key.id);
    await expect(runProvisioning({ ...request, tenantName: 'Changed' })).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
    await expect(runProvisioning({ ...request, keyName: 'Changed admin' })).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
    await expect(runProvisioning({ ...request, role: ApiKeyRole.SERVICE })).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
    await expect(
      runProvisioning({ ...request, rawApiKey: generateApiKey() }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    expect(
      await db.select().from(apiKeys).where(eq(apiKeys.tenantId, request.tenantId)),
    ).toHaveLength(1);
  });

  it('rejects replay after revocation', async () => {
    const request = input('33333333-3333-4333-8333-333333333333');
    const first = await runProvisioning(request);

    await unitOfWork.run(new TenantId(request.tenantId), async ({ services }) => {
      await services.apiKeys.revokeApiKey(
        { apiKeyId: first.key.id, tenantId: request.tenantId, role: ApiKeyRole.ADMIN },
        first.key.id,
      );
    });

    await expect(runProvisioning(request)).rejects.toBeInstanceOf(InvariantViolationError);
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, request.tenantId));
    expect(stored?.revokedAt).not.toBeNull();
  });

  it('supports provisioning alongside bootstrap-created tenants and preserves bootstrap no-op behavior', async () => {
    const bootstrapRawApiKey = generateApiKey();
    const bootstrap = await provisioner.bootstrapInitialAdmin({
      tenantName: 'Bootstrap Tenant',
      keyName: 'Bootstrap admin',
      rawApiKey: bootstrapRawApiKey,
    });
    const next = input('55555555-5555-4555-8555-555555555555');

    expect(bootstrap?.created).toBe(true);
    expect((await runProvisioning(next)).created).toBe(true);
    expect(
      await provisioner.bootstrapInitialAdmin({
        tenantName: 'Ignored',
        keyName: 'Ignored',
        rawApiKey: generateApiKey(),
      }),
    ).toBeNull();
    expect(await db.select().from(tenants)).toHaveLength(2);
  });

  it('serializes concurrent bootstrap calls so only one tenant is created', async () => {
    const concurrentClient = createDbClient({ databaseUrl, max: 2 });
    const concurrentProvisioner = createTenantProvisioningService(concurrentClient);
    try {
      const results = await Promise.all([
        concurrentProvisioner.bootstrapInitialAdmin({
          tenantName: 'Bootstrap A',
          keyName: 'Admin A',
          rawApiKey: generateApiKey(),
        }),
        concurrentProvisioner.bootstrapInitialAdmin({
          tenantName: 'Bootstrap B',
          keyName: 'Admin B',
          rawApiKey: generateApiKey(),
        }),
      ]);

      expect(results.filter((result) => result?.created)).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect(await db.select().from(tenants)).toHaveLength(1);
      expect(await db.select().from(apiKeys)).toHaveLength(1);
    } finally {
      await concurrentClient.sql.end({ timeout: 5 });
    }
  });

  it('does not bootstrap when the only existing credential is revoked', async () => {
    const existing = input('14141414-1414-4141-8141-141414141414');
    const provisioned = await runProvisioning(existing);
    await unitOfWork.run(new TenantId(existing.tenantId), async ({ services }) => {
      await services.apiKeys.revokeApiKey(
        { apiKeyId: provisioned.key.id, tenantId: existing.tenantId, role: ApiKeyRole.ADMIN },
        provisioned.key.id,
      );
    });

    expect(
      await provisioner.bootstrapInitialAdmin({
        tenantName: 'Must be skipped',
        keyName: 'Another admin',
        rawApiKey: generateApiKey(),
      }),
    ).toBeNull();
    expect(await db.select().from(tenants)).toHaveLength(1);
    expect(await db.select().from(apiKeys)).toHaveLength(1);
  });

  it('holds the bootstrap lock through the outer UOW commit, then bootstrap skips', async () => {
    const { provisioningResult, bootstrapResult, request } =
      await runBootstrapProvisioningRace(false);

    expect(provisioningResult.status).toBe('fulfilled');
    expect(bootstrapResult).toEqual({ status: 'fulfilled', value: null });
    expect(await findTenant(request.tenantId)).not.toBeNull();
    expect(await db.select().from(tenants)).toHaveLength(1);
  });

  it('releases the bootstrap lock on UOW rollback so bootstrap can create its initial admin', async () => {
    const { provisioningResult, bootstrapResult, request } =
      await runBootstrapProvisioningRace(true);

    expect(provisioningResult.status).toBe('rejected');
    expect(bootstrapResult).toMatchObject({ status: 'fulfilled', value: { created: true } });
    expect(await findTenant(request.tenantId)).toBeNull();
    expect(await db.select().from(tenants)).toHaveLength(1);
    expect(await db.select().from(apiKeys)).toHaveLength(1);
  });

  it('rolls tenant creation back when a credential uniqueness constraint fails', async () => {
    const credential = generateApiKey();
    const first = input('66666666-6666-4666-8666-666666666666', { rawApiKey: credential });
    const conflicting = input('77777777-7777-4777-8777-777777777777', { rawApiKey: credential });
    await runProvisioning(first);

    await expect(runProvisioning(conflicting)).rejects.toThrow();
    expect(await findTenant(conflicting.tenantId)).toBeNull();
    expect(await db.select().from(apiKeys)).toHaveLength(1);
  });

  it('rolls provisioning back when the host callback fails', async () => {
    const request = input('88888888-8888-4888-8888-888888888888');

    await expect(
      unitOfWork.run(new TenantId(request.tenantId), async ({ provisioning }) => {
        await provisioning.provisionTenant(request);
        throw new Error('host failed after provisioning');
      }),
    ).rejects.toThrow('host failed after provisioning');

    expect(await findTenant(request.tenantId)).toBeNull();
    expect(await db.select().from(apiKeys)).toHaveLength(0);
  });

  it('rolls provisioning back when a later application service operation fails', async () => {
    const request = input('99999999-9999-4999-8999-999999999999');

    await expect(
      unitOfWork.run(new TenantId(request.tenantId), async ({ provisioning, services }) => {
        await provisioning.provisionTenant(request);
        await services.assets.create({ tenantId: request.tenantId, code: 'x', scale: 2 });
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    expect(await findTenant(request.tenantId)).toBeNull();
    expect(await db.select().from(apiKeys)).toHaveLength(0);
  });

  it('keeps tenant data isolated and rejects cross-tenant admin key management in a UOW', async () => {
    const tenantA = input('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const tenantB = input('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { role: ApiKeyRole.SERVICE });
    const keyA = await runProvisioning(tenantA);
    await runProvisioning(tenantB);
    const adminA = await apiKeyService.authenticate(tenantA.rawApiKey);
    const serviceB = await apiKeyService.authenticate(tenantB.rawApiKey);

    await expect(
      apiKeyService.createApiKey(adminA, {
        tenantId: tenantB.tenantId,
        name: 'Cross-tenant key',
        role: ApiKeyRole.SERVICE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      unitOfWork.run(new TenantId(tenantB.tenantId), ({ services }) =>
        services.apiKeys.createApiKey(serviceB, {
          tenantId: tenantB.tenantId,
          name: 'Service-created key',
          role: ApiKeyRole.SERVICE,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      unitOfWork.run(new TenantId(tenantB.tenantId), async ({ services }) => {
        await services.apiKeys.revokeApiKey(adminA, keyA.key.id);
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    const keysA = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantA.tenantId));
    const keysB = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantB.tenantId));
    expect(keysA[0]?.revokedAt).toBeNull();
    expect(keysB).toHaveLength(1);
    expect(keysB[0]?.tenantId).toBe(tenantB.tenantId);

    await expect(
      unitOfWork.run(new TenantId(tenantA.tenantId), ({ provisioning }) =>
        provisioning.provisionTenant({ ...tenantA, tenantId: tenantB.tenantId }),
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    expect(await findTenant(tenantB.tenantId)).not.toBeNull();
  });

  it('serializes concurrent retries for one tenant and allows different tenants concurrently', async () => {
    const concurrentClient = createDbClient({ databaseUrl, max: 4 });
    const concurrentProvisioner = createTenantProvisioningService(concurrentClient);
    const run = (request: ReturnType<typeof input>) =>
      concurrentProvisioner.provisionTenant(request);
    try {
      const same = input('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      const sameResults = await Promise.all([run(same), run(same)]);
      expect(sameResults.map((result) => result.created).sort()).toEqual([false, true]);
      expect(
        await db.select().from(apiKeys).where(eq(apiKeys.tenantId, same.tenantId)),
      ).toHaveLength(1);

      const contested = input('cccccccc-cccc-4ccc-8ccc-cccccccccccd');
      const roleConflict = { ...contested, role: ApiKeyRole.SERVICE };
      const conflictingResults = await Promise.allSettled([run(contested), run(roleConflict)]);
      expect(conflictingResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(conflictingResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(
        await db.select().from(apiKeys).where(eq(apiKeys.tenantId, contested.tenantId)),
      ).toHaveLength(1);

      const one = input('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      const two = input('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
      const differentResults = await Promise.all([run(one), run(two)]);
      expect(differentResults.map((result) => result.created)).toEqual([true, true]);
      expect(await findTenant(one.tenantId)).not.toBeNull();
      expect(await findTenant(two.tenantId)).not.toBeNull();
    } finally {
      await concurrentClient.sql.end({ timeout: 5 });
    }
  });
});
