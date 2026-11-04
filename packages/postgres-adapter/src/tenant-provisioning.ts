import {
  TenantProvisioningService,
  type TenantProvisioningStore,
  type TenantProvisioningTransaction,
} from '@borecount/core/tenant';
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient, DrizzleDatabase } from './client';
import { toApiKeyEntity } from './mappers/api-key-mapper';
import { apiKeys, tenants } from './schema';

const BOOTSTRAP_LOCK_KEY = 'luxledger.bootstrap_admin';

class PostgresTenantProvisioningTransaction implements TenantProvisioningTransaction {
  public constructor(private readonly client: DbClient) {}

  public run<T>(
    tenantId: string,
    work: (store: TenantProvisioningStore) => Promise<T>,
  ): Promise<T> {
    return this.client.runTenantTx(tenantId, 'provision tenant', async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${BOOTSTRAP_LOCK_KEY}))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      return work(createTenantProvisioningStore(tx, tenantId));
    });
  }

  public runBootstrap<T>(
    tenantId: string,
    work: (store: TenantProvisioningStore) => Promise<T>,
  ): Promise<T | null> {
    return this.client.runTx('bootstrap initial admin', async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${BOOTSTRAP_LOCK_KEY}))`);
      const [existingKey] = await tx.select({ id: apiKeys.id }).from(apiKeys).limit(1);
      if (existingKey) return null;

      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      return work(createTenantProvisioningStore(tx, tenantId));
    });
  }
}

const createTenantProvisioningStore = (
  tx: DrizzleDatabase,
  tenantId: string,
): TenantProvisioningStore => ({
  findTenantName: async () => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    return tenant?.name ?? null;
  },
  insertTenant: async (name) => {
    await tx.insert(tenants).values({ id: tenantId, name });
  },
  findCredential: async (keyHash) => {
    const [key] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.keyHash, keyHash)));
    return key ? toApiKeyEntity(key) : null;
  },
  insertCredential: async (input) => {
    const [key] = await tx.insert(apiKeys).values(input).returning();
    return toApiKeyEntity(key);
  },
});

export const createTenantProvisioningService = (client: DbClient): TenantProvisioningService =>
  new TenantProvisioningService(new PostgresTenantProvisioningTransaction(client));
