import type { ApiKeyEntity } from '../api-key/entity';
import type { CreateApiKeyInput } from '../api-key/input.interface';

export interface TenantProvisioningStore {
  findTenantName(): Promise<string | null>;
  insertTenant(name: string): Promise<void>;
  findCredential(keyHash: string): Promise<ApiKeyEntity | null>;
  insertCredential(input: CreateApiKeyInput): Promise<ApiKeyEntity>;
}

export interface TenantProvisioningTransaction {
  /** Serialize attempts for this tenant and roll back all writes if work throws. */
  run<T>(tenantId: string, work: (store: TenantProvisioningStore) => Promise<T>): Promise<T>;
  /** Provision only when the global API-key store is empty, atomically with the inserts. */
  runBootstrap<T>(
    tenantId: string,
    work: (store: TenantProvisioningStore) => Promise<T>,
  ): Promise<T | null>;
}
