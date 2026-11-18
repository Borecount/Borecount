import type { ApiKeyRole } from '../api-key/entity';

export interface ProvisionTenantInput {
  /** Stable, host-generated lowercase UUIDv7 used for every retry of this onboarding operation. */
  tenantId: string;
  tenantName: string;
  keyName: string;
  role: ApiKeyRole;
  /** Generate once with generateApiKey and retain securely before the first attempt. */
  rawApiKey: string;
}

export type BootstrapInitialAdminInput = Omit<ProvisionTenantInput, 'tenantId' | 'role'>;
