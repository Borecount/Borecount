import { describe, expect, it } from 'bun:test';
import { ApiKeyEntity, ApiKeyRole } from '@borecount/core';
import { generateApiKey } from '@borecount/core/application';
import { InvariantViolationError } from '../application/errors';
import {
  type ProvisionTenantInput,
  TenantProvisioningService,
  type TenantProvisioningStore,
  type TenantProvisioningTransaction,
} from './index';

const tenantId = '11111111-1111-4111-8111-111111111111';

class InMemoryProvisioningTransaction implements TenantProvisioningTransaction {
  private tenants = new Map<string, string>();
  private keys = new Map<string, ApiKeyEntity[]>();
  private nextId = 1;

  public async run<T>(
    id: string,
    work: (store: TenantProvisioningStore) => Promise<T>,
  ): Promise<T> {
    const tenantSnapshot = new Map(this.tenants);
    const keysSnapshot = new Map([...this.keys].map(([key, value]) => [key, [...value]]));
    try {
      return await work({
        findTenantName: async () => this.tenants.get(id) ?? null,
        insertTenant: async (name) => {
          this.tenants.set(id, name);
        },
        findCredential: async (keyHash) =>
          this.keys.get(id)?.find((key) => key.keyHash === keyHash) ?? null,
        insertCredential: async (input) => {
          const key = new ApiKeyEntity({
            id: `key-${this.nextId++}`,
            ...input,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            revokedAt: null,
          });
          this.keys.set(id, [...(this.keys.get(id) ?? []), key]);
          return key;
        },
      });
    } catch (error) {
      this.tenants = tenantSnapshot;
      this.keys = keysSnapshot;
      throw error;
    }
  }

  public async runBootstrap<T>(
    id: string,
    work: (store: TenantProvisioningStore) => Promise<T>,
  ): Promise<T | null> {
    if ([...this.keys.values()].some((keys) => keys.length > 0)) return null;
    return this.run(id, work);
  }

  public revoke(id: string, keyId: string): void {
    this.keys.set(
      id,
      (this.keys.get(id) ?? []).map((key) =>
        key.id === keyId
          ? new ApiKeyEntity({ ...key, revokedAt: new Date('2026-01-02T00:00:00.000Z') })
          : key,
      ),
    );
  }

  public tenantName(id: string): string | null {
    return this.tenants.get(id) ?? null;
  }

  public credentials(id: string): ApiKeyEntity[] {
    return this.keys.get(id) ?? [];
  }
}

const input = (overrides: Partial<ProvisionTenantInput> = {}): ProvisionTenantInput => ({
  tenantId,
  tenantName: 'Example Tenant',
  keyName: 'Initial admin',
  role: ApiKeyRole.ADMIN,
  rawApiKey: generateApiKey(),
  ...overrides,
});

describe('TenantProvisioningService', () => {
  it.each([
    ApiKeyRole.ADMIN,
    ApiKeyRole.SERVICE,
  ])('creates a tenant and %s credential', async (role) => {
    const transaction = new InMemoryProvisioningTransaction();
    const service = new TenantProvisioningService(transaction);
    const request = input({ role });

    const result = await service.provisionTenant(request);

    expect(result.created).toBe(true);
    expect(result.tenantId).toBe(tenantId);
    expect(result.key.tenantId).toBe(tenantId);
    expect(result.key.role).toBe(role);
    expect(result.key.name).toBe(request.keyName);
    expect(result.key.keyHash).toBe(
      new Bun.CryptoHasher('sha256').update(request.rawApiKey).digest('hex'),
    );
    expect(transaction.tenantName(tenantId)).toBe(request.tenantName);
    expect(transaction.credentials(tenantId)).toHaveLength(1);
  });

  it('returns the same credential for an exact retry without creating another key', async () => {
    const transaction = new InMemoryProvisioningTransaction();
    const service = new TenantProvisioningService(transaction);
    const request = input();

    const first = await service.provisionTenant(request);
    const retry = await service.provisionTenant(request);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.key.id).toBe(first.key.id);
    expect(transaction.credentials(tenantId)).toHaveLength(1);
  });

  it('bootstraps an ADMIN tenant through the shared generated-key workflow', async () => {
    const transaction = new InMemoryProvisioningTransaction();
    const service = new TenantProvisioningService(transaction);
    const rawApiKey = generateApiKey();

    const result = await service.bootstrapInitialAdmin({
      tenantName: 'Bootstrap Tenant',
      keyName: 'Bootstrap admin',
      rawApiKey,
    });

    expect(result?.created).toBe(true);
    if (!result) throw new Error('Bootstrap unexpectedly skipped');
    expect(result?.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result?.key.role).toBe(ApiKeyRole.ADMIN);
    expect(result?.key.keyHash).toBe(
      new Bun.CryptoHasher('sha256').update(rawApiKey).digest('hex'),
    );
    expect(transaction.tenantName(result.tenantId)).toBe('Bootstrap Tenant');
  });

  it('skips bootstrap when any tenant already has an API key', async () => {
    const transaction = new InMemoryProvisioningTransaction();
    const service = new TenantProvisioningService(transaction);
    await service.provisionTenant(input());

    const result = await service.bootstrapInitialAdmin({
      tenantName: 'Ignored',
      keyName: 'Ignored admin',
      rawApiKey: generateApiKey(),
    });

    expect(result).toBeNull();
    expect(transaction.credentials(tenantId)).toHaveLength(1);
  });

  it('rejects invalid bootstrap credentials before starting a transaction', async () => {
    let transactionCalls = 0;
    const transaction: TenantProvisioningTransaction = {
      run: async () => {
        transactionCalls += 1;
        throw new Error('normal transaction should not be opened');
      },
      runBootstrap: async () => {
        transactionCalls += 1;
        throw new Error('bootstrap transaction should not be opened');
      },
    };

    await expect(
      new TenantProvisioningService(transaction).bootstrapInitialAdmin({
        tenantName: 'Bootstrap Tenant',
        keyName: 'Bootstrap admin',
        rawApiKey: 'not-generated',
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    expect(transactionCalls).toBe(0);
  });

  it('normalizes tenant and key names consistently for retries', async () => {
    const transaction = new InMemoryProvisioningTransaction();
    const service = new TenantProvisioningService(transaction);
    const rawApiKey = generateApiKey();
    const first = await service.provisionTenant(
      input({ tenantName: ' Example Tenant ', keyName: ' Initial admin ', rawApiKey }),
    );
    const retry = await service.provisionTenant(input({ rawApiKey }));

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.key.id).toBe(first.key.id);
    expect(transaction.tenantName(tenantId)).toBe('Example Tenant');
  });

  it.each([
    ['tenant name', { tenantName: 'Changed Tenant' }],
    ['key name', { keyName: 'Changed admin' }],
    ['role', { role: ApiKeyRole.SERVICE }],
    ['credential', { rawApiKey: generateApiKey() }],
  ] as const)('rejects a retry with a changed %s and preserves existing state', async (_label, change) => {
    const transaction = new InMemoryProvisioningTransaction();
    const service = new TenantProvisioningService(transaction);
    const request = input();
    const first = await service.provisionTenant(request);

    await expect(service.provisionTenant({ ...request, ...change })).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
    expect(transaction.tenantName(tenantId)).toBe(request.tenantName);
    expect(transaction.credentials(tenantId).map((key) => key.id)).toEqual([first.key.id]);
  });

  it('rejects replay after the provisioned credential has been revoked', async () => {
    const transaction = new InMemoryProvisioningTransaction();
    const service = new TenantProvisioningService(transaction);
    const request = input();
    const first = await service.provisionTenant(request);
    transaction.revoke(tenantId, first.key.id);

    await expect(service.provisionTenant(request)).rejects.toBeInstanceOf(InvariantViolationError);
    expect(transaction.credentials(tenantId)).toHaveLength(1);
    expect(transaction.credentials(tenantId)[0]?.revokedAt).not.toBeNull();
  });

  it.each([
    [
      'non-canonical tenant UUID',
      { tenantId: '11111111-1111-4111-8abc-111111111111'.toUpperCase() },
    ],
    ['empty tenant name', { tenantName: '  ' }],
    ['empty key name', { keyName: '' }],
    ['invalid key format', { rawApiKey: 'not-generated' }],
    ['unsupported role', { role: 'OWNER' as never }],
  ])('rejects %s before opening a transaction', async (_label, change) => {
    let transactionCalls = 0;
    const transaction: TenantProvisioningTransaction = {
      run: async () => {
        transactionCalls += 1;
        throw new Error('transaction should not be opened');
      },
      runBootstrap: async () => {
        transactionCalls += 1;
        throw new Error('transaction should not be opened');
      },
    };
    const service = new TenantProvisioningService(transaction);

    await expect(service.provisionTenant(input(change))).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
    expect(transactionCalls).toBe(0);
  });
});
