import { hashApiKey } from '../api-key/credentials';
import type { ApiKeyEntity } from '../api-key/entity';
import { ApiKeyRole } from '../api-key/entity';
import { InvariantViolationError } from '../application/errors';
import { assertNonEmpty } from '../utils';
import type { ProvisionTenantInput } from './input.interface';
import type { TenantProvisioningTransaction } from './repository.interface';

export interface ProvisionTenantResult {
  created: boolean;
  tenantId: string;
  key: ApiKeyEntity;
}

/** Trusted host capability. Host authorization must precede every invocation. */
export class TenantProvisioningService {
  public constructor(private readonly transaction: TenantProvisioningTransaction) {}

  public async provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.tenantId)) {
      throw new InvariantViolationError('tenantId must be a canonical UUID');
    }
    assertNonEmpty(input.tenantName, 'tenantName is required');
    assertNonEmpty(input.keyName, 'keyName is required');
    if (!/^llk_[0-9a-f]{64}$/.test(input.rawApiKey)) {
      throw new InvariantViolationError('rawApiKey must be a generated API key');
    }
    if (input.role !== ApiKeyRole.ADMIN && input.role !== ApiKeyRole.SERVICE) {
      throw new InvariantViolationError('Invalid API key role');
    }
    const tenantName = input.tenantName.trim();
    const credential = {
      tenantId: input.tenantId,
      name: input.keyName.trim(),
      role: input.role,
      keyHash: hashApiKey(input.rawApiKey),
    };
    return this.transaction.run(input.tenantId, async (store) => {
      const existingName = await store.findTenantName();
      if (existingName !== null) {
        const key = await store.findCredential(credential.keyHash);
        if (
          existingName !== tenantName ||
          !key ||
          key.tenantId !== input.tenantId ||
          key.name !== credential.name ||
          key.role !== credential.role ||
          key.revokedAt !== null
        ) {
          throw new InvariantViolationError('Tenant provisioning conflicts with existing state');
        }
        return { created: false, tenantId: input.tenantId, key };
      }
      await store.insertTenant(tenantName);
      const key = await store.insertCredential(credential);
      return { created: true, tenantId: input.tenantId, key };
    });
  }
}
