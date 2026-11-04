import {
  TenantProvisioningService,
  type TenantProvisioningStore,
  type TenantProvisioningTransaction,
} from '@borecount/core/tenant';
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from './client';
import { toApiKeyEntity } from './mappers/api-key-mapper';
import { apiKeys, tenants } from './schema';

class PostgresTenantProvisioningTransaction implements TenantProvisioningTransaction {
  public constructor(private readonly client: DbClient) {}

  public run<T>(
    tenantId: string,
    work: (store: TenantProvisioningStore) => Promise<T>,
  ): Promise<T> {
    return this.client.runTenantTx(tenantId, 'provision tenant', async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      return work({
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
    });
  }
}

export const createTenantProvisioningService = (client: DbClient): TenantProvisioningService =>
  new TenantProvisioningService(new PostgresTenantProvisioningTransaction(client));
