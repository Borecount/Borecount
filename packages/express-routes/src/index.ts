import type { ApplicationServices } from '@borecount/core/application';
import type { LedgerAdapterOptions as HttpLedgerAdapterOptions } from '@borecount/http/route-core';
import express, { type Application } from 'express';
import { registerAccountRoutes } from './routes/accounts';
import { registerAdjustmentRoutes } from './routes/adjustments';
import { registerAdminApiKeyRoutes } from './routes/admin-api-keys';
import { registerCreditGrantRoutes } from './routes/credit-grants';
import { registerEntryRoutes } from './routes/entries';
import { registerHoldRoutes } from './routes/holds';
import { registerLedgerRoutes } from './routes/ledgers';
import { registerReconciliationRoutes } from './routes/reconciliation';
import { registerTransactionRoutes } from './routes/transactions';
import type { RequestWithContext } from './types';

export type { RequestContext, RequestWithContext } from './types';

export type LedgerAdapterOptions = HttpLedgerAdapterOptions<RequestWithContext>;

export const registerLedgerAdapter = (
  app: Application,
  services: ApplicationServices,
  options?: LedgerAdapterOptions,
): void => {
  const authorizeAdjustment = options?.authorizeAdjustment;
  if (authorizeAdjustment !== false && typeof authorizeAdjustment !== 'function') {
    throw new Error('authorizeAdjustment must be a function or explicitly false');
  }
  app.use(express.json());

  registerLedgerRoutes(app, services);
  registerTransactionRoutes(app, services);
  registerAccountRoutes(app, services);
  registerCreditGrantRoutes(app, services);
  registerAdjustmentRoutes(
    app,
    services,
    authorizeAdjustment === false ? undefined : authorizeAdjustment,
  );
  registerHoldRoutes(app, services);
  registerReconciliationRoutes(app, services);
  registerEntryRoutes(app, services);
  registerAdminApiKeyRoutes(app, services);
};
