import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantId } from '@borecount/core/base';
import { InvariantViolationError, isDomainError, RepositoryError } from '@borecount/core/errors';
import type { DbClient } from './client';
import {
  type AdapterUnitOfWork,
  createUnitOfWorkContext,
  type UnitOfWorkContext,
} from './unit-of-work/context';

export type { AdapterUnitOfWork, UnitOfWorkContext } from './unit-of-work/context';

const NESTED_UNIT_OF_WORK_MESSAGE = 'Nested unit of work is not supported';

class UnitOfWorkCallbackFailure extends Error {
  public constructor(public readonly original: unknown) {
    super('Unit of work callback failed');
  }
}

export class PostgresUnitOfWork<THostSchema extends Record<string, unknown> = Record<never, never>>
  implements AdapterUnitOfWork<THostSchema>
{
  private readonly active = new AsyncLocalStorage<boolean>();

  public constructor(private readonly client: DbClient<THostSchema>) {}

  public run<T>(
    tenantId: TenantId,
    work: (context: UnitOfWorkContext<THostSchema>) => Promise<T>,
  ): Promise<T> {
    if (this.active.getStore()) {
      throw new InvariantViolationError(NESTED_UNIT_OF_WORK_MESSAGE);
    }

    return this.active
      .run(true, () =>
        this.client.runTenantTx(tenantId.value, 'run tenant unit of work', async (transaction) => {
          try {
            return await work(createUnitOfWorkContext(this.client, transaction, tenantId));
          } catch (error) {
            if (isDomainError(error)) throw error;
            throw new UnitOfWorkCallbackFailure(error);
          }
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof RepositoryError && error.cause instanceof UnitOfWorkCallbackFailure) {
          throw error.cause.original;
        }
        throw error;
      });
  }
}

export const createUnitOfWork = <THostSchema extends Record<string, unknown>>(
  client: DbClient<THostSchema>,
): AdapterUnitOfWork<THostSchema> => new PostgresUnitOfWork(client);
