import './fastify-extensions';
import type { ApplicationServices } from '@borecount/core/application';
import type { LedgerAdapterOptions as HttpLedgerAdapterOptions } from '@borecount/http/route-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountsRoutes } from './routes/accounts';
import { AdjustmentRoutes } from './routes/adjustments';
import { AdminApiKeyRoutes } from './routes/admin-api-keys';
import { CreditGrantRoutes } from './routes/credit-grants';
import { EntriesListRoute } from './routes/entries';
import { HoldsRoutes } from './routes/holds';
import { LedgerRoutes } from './routes/ledgers';
import { ReconRoutes } from './routes/reconciliation';
import { TransactionsRoutes } from './routes/transactions';

export type LedgerAdapterOptions = HttpLedgerAdapterOptions<FastifyRequest>;

export const registerLedgerAdapter = (
  server: FastifyInstance,
  services: ApplicationServices,
  options?: LedgerAdapterOptions,
): void => {
  const authorizeAdjustment = options?.authorizeAdjustment;
  if (authorizeAdjustment !== false && typeof authorizeAdjustment !== 'function') {
    throw new Error('authorizeAdjustment must be a function or explicitly false');
  }
  new LedgerRoutes(services.ledgers, services.transactions, services.balances).register(server);
  new AccountsRoutes(services.accounts, services.balances, services.statements).register(server);
  new CreditGrantRoutes(services.creditGrants).register(server);
  new AdjustmentRoutes(
    services.adjustments,
    authorizeAdjustment === false ? undefined : authorizeAdjustment,
  ).register(server);
  new TransactionsRoutes(services.transactions).register(server);
  new HoldsRoutes(services.holds).register(server);
  new EntriesListRoute(services.transactions).register(server);
  new ReconRoutes(services.reconciliation).register(server);
  new AdminApiKeyRoutes(services.apiKeys).register(server);
};
