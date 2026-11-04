import {
  type ApplicationUnitOfWorkContext,
  InvariantViolationError,
} from '@borecount/core/application';
import type { TenantId, UnitOfWork } from '@borecount/core/base';
import type { TenantProvisioningService } from '@borecount/core/tenant';
import { createApplicationServices } from '../application-services';
import type { DbClient, DrizzleDatabase } from '../client';
import { createTenantProvisioningService } from '../tenant-provisioning';

export interface UnitOfWorkContext<
  THostSchema extends Record<string, unknown> = Record<never, never>,
> extends ApplicationUnitOfWorkContext {
  readonly tx: DrizzleDatabase<THostSchema>;
  readonly provisioning: TenantProvisioningService;
}

export type AdapterUnitOfWork<THostSchema extends Record<string, unknown> = Record<never, never>> =
  UnitOfWork<UnitOfWorkContext<THostSchema>>;

const TENANT_MISMATCH_MESSAGE = 'Unit of work tenant does not match operation tenant';
const UNSCOPED_OPERATION_MESSAGE = 'Unscoped operation is not allowed in a tenant unit of work';

const bindClientToTransaction = <THostSchema extends Record<string, unknown>>(
  client: DbClient<THostSchema>,
  transaction: DrizzleDatabase<THostSchema>,
  tenantId: string,
): DbClient => {
  // The combined transaction always contains the complete Borecount schema.
  // Repositories receive only the narrower package-owned schema view.
  const ledgerTransaction = transaction as unknown as DrizzleDatabase;
  return {
    sql: client.sql,
    execute: (operation, action) => client.execute(operation, () => action(ledgerTransaction)),
    runTx: async () => {
      throw new InvariantViolationError(UNSCOPED_OPERATION_MESSAGE);
    },
    runTenantTx: async (operationTenantId, _operation, action) => {
      if (operationTenantId !== tenantId) {
        throw new InvariantViolationError(TENANT_MISMATCH_MESSAGE);
      }
      return client.execute(_operation, () => action(ledgerTransaction));
    },
  };
};

export const createUnitOfWorkContext = <THostSchema extends Record<string, unknown>>(
  client: DbClient<THostSchema>,
  transaction: DrizzleDatabase<THostSchema>,
  tenantId: TenantId,
): UnitOfWorkContext<THostSchema> => {
  const transactionClient = bindClientToTransaction(client, transaction, tenantId.value);
  return {
    tenantId,
    services: createApplicationServices(transactionClient),
    provisioning: createTenantProvisioningService(transactionClient),
    tx: transaction,
  };
};
