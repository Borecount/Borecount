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

const ensureJsonMiddleware = (app: Application): void => {
  const stack = (app as Application & { _router?: { stack?: unknown[] } })._router?.stack;
  if (!Array.isArray(stack) || stack.length === 0) {
    app.use(express.json());
  }
};

export type LedgerAdapterOptions = HttpLedgerAdapterOptions<RequestWithContext>;

export const registerLedgerAdapter = (
  app: Application,
  services: ApplicationServices,
  options: LedgerAdapterOptions = {},
): void => {
  if (options.requireAdjustmentAuthorization && typeof options.authorizeAdjustment !== 'function') {
    throw new Error(
      'authorizeAdjustment is required when requireAdjustmentAuthorization is enabled',
    );
  }
  ensureJsonMiddleware(app);

  registerLedgerRoutes(app, services);
  registerTransactionRoutes(app, services);
  registerAccountRoutes(app, services);
  registerCreditGrantRoutes(app, services);
  registerAdjustmentRoutes(app, services, options.authorizeAdjustment);
  registerHoldRoutes(app, services);
  registerReconciliationRoutes(app, services);
  registerEntryRoutes(app, services);
  registerAdminApiKeyRoutes(app, services);
};

export const registerLedgerExpressAdapter = registerLedgerAdapter;
