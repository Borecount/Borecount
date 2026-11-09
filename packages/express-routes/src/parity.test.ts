import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  ApiKeyRole,
  type ApiKeyService,
  type ApplicationServices,
  type Asset,
  type AssetRepository,
  AssetService,
  type CreateAdjustmentInput,
  type CreditGrant,
} from '@borecount/core/application';
import type { UnknownRecord } from '@borecount/core/base';
import {
  AdjustmentConflictError,
  AssetCodeConflictError,
  CreditGrantConflictError,
  DomainError,
  ForbiddenError,
  HoldNotFoundError,
  InvariantViolationError,
  RateLimitExceededError,
  ReconRunNotFoundError,
  ReconUploadNotFoundError,
  UnauthorizedError,
  UnbalancedTransactionError,
} from '@borecount/core/errors';
import type { TransactionMetadata } from '@borecount/core/transaction';
import { registerLedgerAdapter as registerFastifyLedgerAdapter } from '@borecount/fastify-routes';
import { defaultErrorResponses } from '@borecount/http';
import { toHttpErrorPayload } from '@borecount/http/errors';
import type { AdjustmentAuthorizationHook, LedgerAdapterOptions } from '@borecount/http/route-core';
import { createContractHarness } from '@borecount/http/test/harness';
import express, { type Application } from 'express';
import Fastify, { type FastifyInstance } from 'fastify';
import httpMocks from 'node-mocks-http';
import { registerLedgerAdapter as registerExpressLedgerAdapter } from './index';

type RequestResult = {
  status: number;
  json: unknown;
};

const tenantId = '11111111-1111-4111-8111-111111111111';
const holdId = '00000000-0000-4000-8000-000000000410';
const unknownHoldId = '00000000-0000-4000-8000-000000000411';
const emptyHoldId = '00000000-0000-4000-8000-000000000418';
const listObservations = new Map<string, unknown[]>();

const observeList = (endpoint: string, input: unknown): void => {
  listObservations.set(endpoint, [...(listObservations.get(endpoint) ?? []), input]);
};

const adjustmentPayload = {
  ledger_id: '00000000-0000-4000-8000-000000000001',
  account_id: '00000000-0000-4000-8000-000000000101',
  offset_account_id: '00000000-0000-4000-8000-000000000102',
  reference: 'adjustment-1',
  amount_minor: '25',
  description: 'Support correction',
  reason_code: 'SUPPORT',
  actor_id: 'operator-1',
  attributes: { ticket: 'T-1' },
};

class IdempotencyConflictTestError extends DomainError {
  public constructor(message: string) {
    super(message, 'IDEMPOTENCY_CONFLICT', 409);
  }
}

type FakeAccount = {
  id: string;
  tenantId: string;
  ledgerId: string;
  code: string | null;
  name: string;
  side: 'DEBIT' | 'CREDIT';
  overdraftPolicy: 'ALLOW' | 'DISALLOW';
  grantEnabled: boolean;
  currency: string;
  balanceMinor: bigint;
  createdAt: Date;
};

class FakeLedgerService {
  private txByReference = new Map<string, string>();
  private txMetadataByReference = new Map<string, TransactionMetadata | undefined>();
  private lastAccount: FakeAccount | null = null;
  private accountCreateError: Error | null = null;

  public setAccountCreateError(error: Error | null): void {
    this.accountCreateError = error;
  }

  public metadataFor(reference: string): TransactionMetadata | undefined {
    return this.txMetadataByReference.get(`${tenantId}:${reference}`);
  }

  private transactionResponse(metadata: TransactionMetadata) {
    return {
      id: { value: '00000000-0000-4000-8000-000000000301' },
      tenantId,
      ledgerId: { value: '00000000-0000-4000-8000-000000000001' },
      reference: 'adapter-metadata-read',
      currency: 'USD',
      description: null,
      relatedTransactionId: null,
      relationType: null,
      effectiveAt: null,
      createdAt: new Date('2026-01-01T00:01:00.000Z'),
      metadata,
      entries: [],
    };
  }

  public async getById(_tenantId: string, _transactionId: string) {
    return this.transactionResponse({ provider: { payment_id: 'read-1' } });
  }

  public async list(_query: unknown) {
    observeList('transactions', _query);
    return {
      data: [this.transactionResponse({ provider: { payment_id: 'read-1' } })],
      nextCursor: null,
    };
  }

  public async create(input: {
    tenantId: string;
    ledgerId: string;
    code?: string | null;
    name: string;
    side: 'DEBIT' | 'CREDIT';
    overdraftPolicy?: 'ALLOW' | 'DISALLOW';
    grantEnabled?: boolean;
    currency: string;
  }): Promise<FakeAccount> {
    if (this.accountCreateError) throw this.accountCreateError;
    const account: FakeAccount = {
      id: '00000000-0000-4000-8000-000000000101',
      tenantId: input.tenantId,
      ledgerId: input.ledgerId,
      code: input.code ?? null,
      name: input.name,
      side: input.side,
      overdraftPolicy: input.overdraftPolicy ?? 'ALLOW',
      grantEnabled: input.grantEnabled ?? false,
      currency: input.currency,
      balanceMinor: 0n,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    this.lastAccount = account;
    return account;
  }

  public async getAccountById(): Promise<FakeAccount> {
    if (!this.lastAccount) throw new Error('No account created');
    return this.lastAccount;
  }

  public async listAccounts(query: unknown): Promise<{ data: FakeAccount[]; nextCursor: null }> {
    observeList('accounts', query);
    return { data: this.lastAccount ? [this.lastAccount] : [], nextCursor: null };
  }

  public async listLedgers(query: unknown): Promise<{ data: unknown[]; nextCursor: null }> {
    observeList('ledgers', query);
    return { data: [], nextCursor: null };
  }

  public async listEntries(query: unknown) {
    observeList('entries', query);
    return { data: [], nextCursor: null };
  }

  private holdSummary() {
    return {
      id: holdId,
      ledgerId: '00000000-0000-4000-8000-000000000001',
      reference: 'hold-parity',
      currency: 'USD',
      description: null,
      state: 'HELD' as const,
      originalAmountMinor: 125n,
      remainingAmountMinor: 75n,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      appliedAt: null,
      voidedAt: null,
    };
  }

  public async getHoldById(_tenantId: string, requestedHoldId: string) {
    if (requestedHoldId !== holdId) throw new HoldNotFoundError(requestedHoldId);
    return this.holdSummary();
  }

  public async listHolds(query: unknown) {
    observeList('holds', query);
    return { data: [this.holdSummary()], nextCursor: null };
  }

  public async listHoldEntries(query: unknown) {
    observeList('hold-entries', query);
    const requestedHoldId = (query as { holdId?: string }).holdId;
    if (requestedHoldId === unknownHoldId) {
      throw new HoldNotFoundError(unknownHoldId);
    }
    if (requestedHoldId === emptyHoldId) return { data: [], nextCursor: null };
    return {
      data: [
        {
          id: '00000000-0000-4000-8000-000000000412',
          accountId: '00000000-0000-4000-8000-000000000413',
          signedAmountMinor: -125n,
          currency: 'USD',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    };
  }

  public async listHoldCaptures(query: unknown) {
    observeList('hold-captures', query);
    const requestedHoldId = (query as { holdId?: string }).holdId;
    if (requestedHoldId === unknownHoldId) {
      throw new HoldNotFoundError(unknownHoldId);
    }
    if (requestedHoldId === emptyHoldId) return { data: [], nextCursor: null };
    return {
      data: [
        {
          id: '00000000-0000-4000-8000-000000000414',
          reference: 'hold-capture-1',
          amountMinor: 50n,
          currency: 'USD',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    };
  }

  public async listHoldCreditAllocations(query: unknown) {
    observeList('hold-credit-allocations', query);
    const requestedHoldId = (query as { holdId?: string }).holdId;
    if (requestedHoldId === unknownHoldId) {
      throw new HoldNotFoundError(unknownHoldId);
    }
    if (requestedHoldId === emptyHoldId) return { data: [], nextCursor: null };
    return {
      data: [
        {
          id: '00000000-0000-4000-8000-000000000415',
          holdEntryId: '00000000-0000-4000-8000-000000000412',
          accountId: '00000000-0000-4000-8000-000000000413',
          grantId: '00000000-0000-4000-8000-000000000416',
          amountMinor: 25n,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    };
  }

  public async listHistory(query: unknown) {
    observeList('balance-history', query);
    return { data: [], nextCursor: null };
  }

  public async listRules(query: unknown) {
    observeList('reconciliation-rules', query);
    return { data: [], nextCursor: null };
  }

  public async listUploads(query: unknown) {
    observeList('reconciliation-uploads', query);
    return { data: [], nextCursor: null };
  }

  public async getUpload(_tenantId: string, uploadId: string) {
    if (uploadId === '01900000-0000-7000-8000-000000000999') {
      throw new ReconUploadNotFoundError(uploadId);
    }
    return {
      id: uploadId,
      tenantId,
      source: 'bank',
      recordCount: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  public async listRecords(query: unknown) {
    observeList('reconciliation-upload-records', query);
    return {
      data: [
        {
          id: '00000000-0000-4000-8000-000000000501',
          externalId: 'bank-row-1',
          amountMinor: 1200n,
          currency: 'USD',
          reference: 'invoice-1',
          description: null,
          occurredAt: new Date('2026-01-01T00:00:00.000Z'),
          raw: { account_number: 'private' },
        },
      ],
      nextCursor: null,
    };
  }

  public async listRuns(query: unknown) {
    observeList('reconciliation-runs', query);
    return { data: [], nextCursor: null };
  }

  public async listResults(query: unknown) {
    observeList('reconciliation-results', query);
    if ((query as { runId?: string }).runId === '01900000-0000-7000-8000-000000000999') {
      throw new ReconRunNotFoundError('01900000-0000-7000-8000-000000000999');
    }
    return { data: [], nextCursor: null };
  }

  public async createTransaction(input: {
    tenantId: string;
    reference: string;
    metadata?: TransactionMetadata;
  }): Promise<{ transactionId: string; created: boolean }> {
    if (input.reference.startsWith('unbalanced-')) {
      throw new UnbalancedTransactionError();
    }
    if (input.reference.startsWith('unexpected-')) {
      throw Object.assign(new Error('duplicate key violates transactions_reference_key'), {
        code: '23505',
        constraint: 'transactions_reference_key',
      });
    }
    const key = `${input.tenantId}:${input.reference}`;
    const existing = this.txByReference.get(key);
    if (existing) {
      if (JSON.stringify(this.txMetadataByReference.get(key)) !== JSON.stringify(input.metadata)) {
        throw new IdempotencyConflictTestError(
          'transaction retry metadata conflicts with the original',
        );
      }
      return { transactionId: existing, created: false };
    }
    const id = '00000000-0000-4000-8000-000000000300';
    this.txByReference.set(key, id);
    this.txMetadataByReference.set(key, input.metadata);
    return { transactionId: id, created: true };
  }

  public async createTransactionsBulk(input: {
    tenantId: string;
    transactions: Array<{ reference: string; metadata?: TransactionMetadata }>;
  }) {
    const transactions = [];
    for (const transaction of input.transactions) {
      const result = await this.createTransaction({
        tenantId: input.tenantId,
        reference: transaction.reference,
        metadata: transaction.metadata,
      });
      transactions.push({
        reference: transaction.reference,
        transactionId: result.transactionId,
        created: result.created,
      });
    }
    return {
      createdCount: transactions.filter((transaction) => transaction.created).length,
      idempotentCount: transactions.filter((transaction) => !transaction.created).length,
      transactions,
    };
  }

  public async reverseTransaction(input: {
    tenantId: string;
    reference: string;
  }): Promise<{ transactionId: string; created: boolean }> {
    return this.createTransaction(input);
  }

  public async correctTransaction(input: {
    tenantId: string;
    reversalReference: string;
    correctedReference: string;
  }): Promise<{
    reversalTransactionId: string;
    correctedTransactionId: string;
    created: boolean;
  }> {
    const reversal = await this.createTransaction({
      tenantId: input.tenantId,
      reference: input.reversalReference,
    });
    const corrected = await this.createTransaction({
      tenantId: input.tenantId,
      reference: input.correctedReference,
    });
    return {
      reversalTransactionId: reversal.transactionId,
      correctedTransactionId: corrected.transactionId,
      created: reversal.created || corrected.created,
    };
  }
}

class FakeApiKeyService {
  public async listApiKeys(auth: unknown, query: unknown) {
    observeList('api-keys', { auth, ...(query as Record<string, unknown>) });
    return { data: [], nextCursor: null };
  }
}

describe('express adapter parity with fastify adapter', () => {
  let fastifyServer: FastifyInstance;
  let expressApp: Application;
  let fakeLedgerService: FakeLedgerService;

  beforeAll(async () => {
    fakeLedgerService = new FakeLedgerService();
    const apiKeyService = new FakeApiKeyService() as unknown as ApiKeyService;
    let lastGrant: CreditGrant | null = null;
    const services = {
      accounts: {
        create: (input: Parameters<FakeLedgerService['create']>[0]) =>
          fakeLedgerService.create(input),
        getById: () => fakeLedgerService.getAccountById(),
        list: (query: unknown) => fakeLedgerService.listAccounts(query),
      },
      creditGrants: {
        create: async (input: {
          tenantId: string;
          ledgerId: string;
          accountId: string;
          fundingAccountId: string;
          reference: string;
          externalReference?: string | null;
          amountMinor: bigint;
          expiresAt?: Date | null;
        }) => {
          lastGrant = {
            id: '00000000-0000-4000-8000-000000000901',
            tenantId: input.tenantId,
            ledgerId: input.ledgerId,
            accountId: input.accountId,
            fundingAccountId: input.fundingAccountId,
            assetId: '00000000-0000-4000-8000-000000000903',
            reference: input.reference,
            externalReference: input.externalReference ?? null,
            amountMinor: input.amountMinor,
            transactionId: '00000000-0000-4000-8000-000000000902',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            expiresAt: input.expiresAt ?? null,
            reversedByTransactionId: null,
          };
          return { created: true, grant: lastGrant };
        },
        getById: async () => {
          if (!lastGrant) throw new Error('No grant created');
          return lastGrant;
        },
        reverse: async () => {
          if (!lastGrant) throw new Error('No grant created');
          lastGrant = {
            ...lastGrant,
            reversedByTransactionId: '00000000-0000-4000-8000-000000000904',
          };
          return { created: true, grant: lastGrant };
        },
        getBalance: async (_tenantId: string, accountId: string) => ({
          accountId,
          assetId: '00000000-0000-4000-8000-000000000903',
          ledgerBalanceMinor: 100n,
          remainingMinor: 100n,
        }),
        list: async (query: unknown) => {
          observeList('credit-grants', query);
          return { data: lastGrant ? [lastGrant] : [], nextCursor: 'next-cursor' };
        },
        listLots: async (query: unknown) => {
          observeList('credit-lots', query);
          return {
            data: [
              {
                grantId: '00000000-0000-4000-8000-000000000901',
                reference: 'parity-grant',
                externalReference: null,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                expiresAt: null,
                grantedMinor: 100n,
                reversedMinor: 0n,
                consumedMinor: 0n,
                compensatedMinor: 0n,
                expiredMinor: 0n,
                remainingMinor: 100n,
              },
            ],
            nextCursor: null,
          };
        },
        refund: async (input: { grantId: string; amountMinor: bigint; reference: string }) => {
          if (input.reference.startsWith('conflict-')) {
            throw new CreditGrantConflictError('Refund exceeds unspent grant capacity');
          }
          return {
            grantId: input.grantId,
            transactionId: '00000000-0000-4000-8000-000000000905',
            amountMinor: input.amountMinor,
            created: !input.reference.startsWith('retry-'),
          };
        },
        listLineageByGrant: async (query: unknown) => {
          observeList('grant-allocations', query);
          return { data: [], nextCursor: null };
        },
        listLineageByTransaction: async (query: unknown) => {
          observeList('transaction-allocations', query);
          return { data: [], nextCursor: null };
        },
        previewExpirations: async (input: { asOf: Date }) => ({ asOf: input.asOf, items: [] }),
        runExpirations: async (input: { asOf: Date }) => ({ asOf: input.asOf, items: [] }),
      },
      adjustments: {
        credit: async (input: { reference: string }) => ({
          transactionId: '00000000-0000-4000-8000-000000000906',
          created: !input.reference.startsWith('retry-'),
        }),
        debit: async (input: { reference: string }) => {
          if (input.reference.startsWith('conflict-')) {
            throw new AdjustmentConflictError();
          }
          return { transactionId: '00000000-0000-4000-8000-000000000907', created: true };
        },
      },
      apiKeys: apiKeyService,
      balances: fakeLedgerService,
      holds: {
        getById: (currentTenantId: string, requestedHoldId: string) =>
          fakeLedgerService.getHoldById(currentTenantId, requestedHoldId),
        list: (query: unknown) => fakeLedgerService.listHolds(query),
        listEntries: (query: unknown) => fakeLedgerService.listHoldEntries(query),
        listCaptures: (query: unknown) => fakeLedgerService.listHoldCaptures(query),
        listCreditAllocations: (query: unknown) =>
          fakeLedgerService.listHoldCreditAllocations(query),
        create: async () => ({ holdId, created: true, state: 'HELD', remainingAmountMinor: 75n }),
        commit: async () => ({
          holdId,
          state: 'APPLIED',
          remainingAmountMinor: 0n,
          transactionId: '00000000-0000-4000-8000-000000000417',
          created: true,
        }),
        void: async () => ({ holdId, state: 'VOIDED', remainingAmountMinor: 0n, voided: true }),
      },
      ledgers: {
        list: (query: unknown) => fakeLedgerService.listLedgers(query),
      },
      reconciliation: fakeLedgerService,
      statements: {
        getAccountStatement: async (input: {
          accountId: string;
          from: Date;
          asOf: Date;
          cursor?: string;
        }) => {
          if (input.cursor === 'invalid-cursor') {
            throw new InvariantViolationError('Invalid cursor');
          }
          return {
            accountId: input.accountId,
            assetId: '00000000-0000-4000-8000-000000000903',
            from: input.from,
            asOf: input.asOf,
            opening: { postedMinor: 0n, reservedDeltaMinor: 0n, availableMinor: 0n },
            closing: { postedMinor: -100n, reservedDeltaMinor: 0n, availableMinor: 100n },
            data: [],
            nextCursor: null,
          };
        },
        getCreditLotStatement: async (input: {
          accountId: string;
          grantId?: string;
          from: Date;
          asOf: Date;
        }) => ({
          accountId: input.accountId,
          assetId: '00000000-0000-4000-8000-000000000903',
          grantId: input.grantId ?? null,
          from: input.from,
          asOf: input.asOf,
          openingAvailableMinor: 0n,
          closingAvailableMinor: 100n,
          data: [],
          nextCursor: null,
        }),
      },
      transactions: {
        create: (input: Parameters<FakeLedgerService['createTransaction']>[0]) =>
          fakeLedgerService.createTransaction(input),
        createBulk: (input: Parameters<FakeLedgerService['createTransactionsBulk']>[0]) =>
          fakeLedgerService.createTransactionsBulk(input),
        getById: (currentTenantId: string, transactionId: string) =>
          fakeLedgerService.getById(currentTenantId, transactionId),
        list: (input: { tenantId: string; limit: number; cursor?: string; ledgerId?: string }) =>
          fakeLedgerService.list(input),
        listEntries: (input: unknown) => fakeLedgerService.listEntries(input),
        reverse: (input: Parameters<FakeLedgerService['reverseTransaction']>[0]) =>
          fakeLedgerService.reverseTransaction(input),
        correct: (input: Parameters<FakeLedgerService['correctTransaction']>[0]) =>
          fakeLedgerService.correctTransaction(input),
      },
    } as unknown as ApplicationServices;

    fastifyServer = Fastify({
      ajv: {
        customOptions: {
          removeAdditional: false,
        },
      },
    });
    fastifyServer.decorateRequest('tenantId');
    fastifyServer.decorateRequest('apiKeyId');
    fastifyServer.decorateRequest('apiKeyRole');
    fastifyServer.addHook('onRequest', async (request) => {
      (request as { tenantId?: string }).tenantId = tenantId;
      (request as { apiKeyId?: string }).apiKeyId = '00000000-0000-4000-8000-000000000001';
      (request as { apiKeyRole?: ApiKeyRole }).apiKeyRole = ApiKeyRole.ADMIN;
    });
    registerFastifyLedgerAdapter(fastifyServer, services, {
      authorizeAdjustment: false,
    });

    expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as { tenantId?: string }).tenantId = tenantId;
      (req as { apiKeyId?: string }).apiKeyId = '00000000-0000-4000-8000-000000000001';
      (req as { apiKeyRole?: ApiKeyRole }).apiKeyRole = ApiKeyRole.ADMIN;
      next();
    });
    registerExpressLedgerAdapter(expressApp, services, { authorizeAdjustment: false });
  });

  afterAll(async () => {
    await fastifyServer.close();
  });

  const requestFastify = async (
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
  ): Promise<RequestResult> => {
    const response = (await fastifyServer.inject({
      method,
      url,
      payload: payload as UnknownRecord | undefined,
    })) as { statusCode: number; body: unknown };
    const textBody =
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return {
      status: response.statusCode,
      json: textBody.length > 0 ? JSON.parse(textBody) : null,
    };
  };

  const requestExpress = async (
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
  ): Promise<RequestResult> => {
    const req = httpMocks.createRequest({
      method,
      url,
      body: payload as object | undefined,
      headers: {
        'content-type': 'application/json',
      },
    }) as unknown as { tenantId?: string; apiKeyId?: string; apiKeyRole?: ApiKeyRole };
    req.tenantId = tenantId;
    req.apiKeyId = '00000000-0000-4000-8000-000000000001';
    req.apiKeyRole = ApiKeyRole.ADMIN;

    const res = httpMocks.createResponse({
      eventEmitter: (await import('node:events')).EventEmitter,
    });

    await new Promise<void>((resolve) => {
      (expressApp as unknown as (req: unknown, res: unknown, next: () => void) => void)(
        req,
        res,
        () => resolve(),
      );
      if (res.writableEnded) {
        resolve();
      } else {
        res.on('finish', () => resolve());
      }
    });

    const responseText = res._getData() as string;
    return {
      status: res.statusCode,
      json: responseText.length > 0 ? JSON.parse(responseText) : null,
    };
  };

  it('reuses framework-agnostic harness runners and keeps focused parity', async () => {
    const harness = createContractHarness();
    harness.runForAdapters(
      [{ name: 'fastify' }, { name: 'express' }],
      [{ name: 'runner smoke', assert: () => expect(true).toBeTrue() }],
    );

    const checks = [
      {
        name: 'GET /v1/ledgers parity',
        run: async () => {
          const [fastifyResponse, expressResponse] = await Promise.all([
            requestFastify('GET', '/v1/ledgers'),
            requestExpress('GET', '/v1/ledgers'),
          ]);
          expect(expressResponse.status).toBe(fastifyResponse.status);
          expect(expressResponse.json).toEqual(fastifyResponse.json);
        },
      },
      {
        name: 'POST /v1/accounts validation error parity',
        run: async () => {
          const payload = {
            name: 'Invalid account payload',
            side: 'DEBIT',
            currency: 'USD',
          };
          const [fastifyResponse, expressResponse] = await Promise.all([
            requestFastify('POST', '/v1/accounts', payload),
            requestExpress('POST', '/v1/accounts', payload),
          ]);
          expect(expressResponse.status).toBe(400);
          expect(fastifyResponse.status).toBe(400);
          expect(expressResponse.json).toEqual(
            expect.objectContaining({
              error: 'INVALID_INPUT',
            }),
          );
          expect(fastifyResponse.json).toEqual(
            expect.objectContaining({
              error: 'INVALID_INPUT',
            }),
          );
        },
      },
      {
        name: 'POST /v1/accounts returns a null code when omitted',
        run: async () => {
          const payload = {
            ledger_id: '00000000-0000-4000-8000-000000000001',
            name: 'Cash',
            side: 'DEBIT',
            overdraft_policy: 'DISALLOW',
            currency: 'USD',
          };
          const [fastifyResponse, expressResponse] = await Promise.all([
            requestFastify('POST', '/v1/accounts', payload),
            requestExpress('POST', '/v1/accounts', payload),
          ]);

          expect(fastifyResponse.status).toBe(201);
          expect(expressResponse.status).toBe(201);
          expect(fastifyResponse.json).toEqual(
            expect.objectContaining({
              code: null,
              overdraft_policy: 'DISALLOW',
              grant_enabled: false,
            }),
          );
          expect(expressResponse.json).toEqual(fastifyResponse.json);
        },
      },
      {
        name: 'POST and GET /v1/accounts expose grant capability parity',
        run: async () => {
          const payload = {
            ledger_id: '00000000-0000-4000-8000-000000000001',
            name: 'Promotional balance',
            side: 'CREDIT',
            overdraft_policy: 'DISALLOW',
            grant_enabled: true,
            currency: 'USD',
          };
          const [fastifyCreated, expressCreated] = await Promise.all([
            requestFastify('POST', '/v1/accounts', payload),
            requestExpress('POST', '/v1/accounts', payload),
          ]);

          expect(fastifyCreated.status).toBe(201);
          expect(expressCreated).toEqual(fastifyCreated);
          expect(fastifyCreated.json).toEqual(expect.objectContaining({ grant_enabled: true }));

          const accountPath = '/v1/accounts/00000000-0000-4000-8000-000000000101';
          const [fastifyRead, expressRead, fastifyList, expressList] = await Promise.all([
            requestFastify('GET', accountPath),
            requestExpress('GET', accountPath),
            requestFastify('GET', '/v1/accounts'),
            requestExpress('GET', '/v1/accounts'),
          ]);
          expect(fastifyRead.status).toBe(200);
          expect(expressRead).toEqual(fastifyRead);
          expect(fastifyRead.json).toEqual(expect.objectContaining({ grant_enabled: true }));
          expect(fastifyList.status).toBe(200);
          expect(expressList).toEqual(fastifyList);
          expect(fastifyList.json).toEqual(
            expect.objectContaining({
              data: [expect.objectContaining({ grant_enabled: true })],
            }),
          );
        },
      },
      {
        name: 'POST /v1/accounts maps account invariant errors identically',
        run: async () => {
          fakeLedgerService.setAccountCreateError(
            new InvariantViolationError(
              'grant-enabled account must use CREDIT side and DISALLOW overdraft',
            ),
          );
          const payload = {
            ledger_id: '00000000-0000-4000-8000-000000000001',
            name: 'Promotional balance',
            side: 'CREDIT',
            overdraft_policy: 'DISALLOW',
            grant_enabled: true,
            currency: 'USD',
          };
          const [fastifyResponse, expressResponse] = await (async () => {
            try {
              return await Promise.all([
                requestFastify('POST', '/v1/accounts', payload),
                requestExpress('POST', '/v1/accounts', payload),
              ]);
            } finally {
              fakeLedgerService.setAccountCreateError(null);
            }
          })();

          expect(fastifyResponse).toEqual({
            status: 400,
            json: {
              error: 'INVARIANT_VIOLATION',
              message: 'grant-enabled account must use CREDIT side and DISALLOW overdraft',
            },
          });
          expect(expressResponse).toEqual(fastifyResponse);
        },
      },
      {
        name: 'POST /v1/accounts rejects an empty code',
        run: async () => {
          const payload = {
            ledger_id: '00000000-0000-4000-8000-000000000001',
            code: '',
            name: 'Cash',
            side: 'DEBIT',
            currency: 'USD',
          };
          const [fastifyResponse, expressResponse] = await Promise.all([
            requestFastify('POST', '/v1/accounts', payload),
            requestExpress('POST', '/v1/accounts', payload),
          ]);

          expect(fastifyResponse.status).toBe(400);
          expect(expressResponse.status).toBe(400);
          expect(expressResponse.json).toEqual(expect.objectContaining({ error: 'INVALID_INPUT' }));
          expect(fastifyResponse.json).toEqual(expect.objectContaining({ error: 'INVALID_INPUT' }));
        },
      },
      {
        name: 'POST /v1/transactions idempotency status parity',
        run: async () => {
          const buildPayload = (reference: string) => ({
            ledger_id: '00000000-0000-4000-8000-000000000001',
            reference,
            currency: 'USD',
            metadata: {
              provider: { payment_id: reference },
              tags: ['settlement'],
            },
            entries: [
              {
                account_id: '00000000-0000-4000-8000-000000000101',
                signed_amount_minor: '100',
                currency: 'USD',
              },
              {
                account_id: '00000000-0000-4000-8000-000000000102',
                signed_amount_minor: '-100',
                currency: 'USD',
              },
            ],
          });

          const firstFastify = await requestFastify(
            'POST',
            '/v1/transactions',
            buildPayload('parity-ref-fastify'),
          );
          const firstExpress = await requestExpress(
            'POST',
            '/v1/transactions',
            buildPayload('parity-ref-express'),
          );
          expect(firstFastify.status).toBe(201);
          expect(firstExpress.status).toBe(201);

          const secondFastify = await requestFastify(
            'POST',
            '/v1/transactions',
            buildPayload('parity-ref-fastify'),
          );
          const secondExpress = await requestExpress(
            'POST',
            '/v1/transactions',
            buildPayload('parity-ref-express'),
          );
          expect(secondFastify.status).toBe(200);
          expect(secondExpress.status).toBe(200);
          expect(secondFastify.json).toEqual(
            expect.objectContaining({
              created: false,
            }),
          );
          expect(secondExpress.json).toEqual(
            expect.objectContaining({
              created: false,
            }),
          );

          const conflictPayload = {
            ...buildPayload('parity-ref-fastify'),
            metadata: { provider: { payment_id: 'different-payment' } },
          };
          const [fastifyConflict, expressConflict] = await Promise.all([
            requestFastify('POST', '/v1/transactions', conflictPayload),
            requestExpress('POST', '/v1/transactions', {
              ...buildPayload('parity-ref-express'),
              metadata: { provider: { payment_id: 'different-payment' } },
            }),
          ]);
          expect(fastifyConflict.status).toBe(409);
          expect(expressConflict).toEqual(fastifyConflict);
        },
      },
      {
        name: 'POST /v1/transactions metadata validation parity',
        run: async () => {
          for (const [index, metadata] of [null, [], 'metadata', 42, true].entries()) {
            const buildPayload = (framework: string) => ({
              ledger_id: '00000000-0000-4000-8000-000000000001',
              reference: `invalid-metadata-${framework}-${index}`,
              currency: 'USD',
              metadata,
              entries: [
                {
                  account_id: '00000000-0000-4000-8000-000000000101',
                  signed_amount_minor: '100',
                  currency: 'USD',
                },
                {
                  account_id: '00000000-0000-4000-8000-000000000102',
                  signed_amount_minor: '-100',
                  currency: 'USD',
                },
              ],
            });
            const [fastifyResponse, expressResponse] = await Promise.all([
              requestFastify('POST', '/v1/transactions', buildPayload('fastify')),
              requestExpress('POST', '/v1/transactions', buildPayload('express')),
            ]);
            expect(fastifyResponse.status).toBe(400);
            expect(expressResponse.status).toBe(400);
            expect(fastifyResponse.json).toEqual(expressResponse.json);
            expect(fastifyResponse.json).toEqual(
              expect.objectContaining({ error: 'INVALID_INPUT' }),
            );
          }
        },
      },
      {
        name: 'POST /v1/transactions rejects zero and malformed signed amounts identically',
        run: async () => {
          for (const [index, signedAmount] of ['0', '-0', '+5', '1.5'].entries()) {
            const buildPayload = (framework: string) => ({
              ledger_id: '00000000-0000-4000-8000-000000000001',
              reference: `invalid-signed-${framework}-${index}`,
              currency: 'USD',
              entries: [
                {
                  account_id: '00000000-0000-4000-8000-000000000101',
                  signed_amount_minor: signedAmount,
                  currency: 'USD',
                },
                {
                  account_id: '00000000-0000-4000-8000-000000000102',
                  signed_amount_minor: '-100',
                  currency: 'USD',
                },
              ],
            });
            const [fastifyResponse, expressResponse] = await Promise.all([
              requestFastify('POST', '/v1/transactions', buildPayload('fastify')),
              requestExpress('POST', '/v1/transactions', buildPayload('express')),
            ]);
            expect(fastifyResponse.status).toBe(400);
            expect(expressResponse.status).toBe(400);
            expect(fastifyResponse.json).toEqual(
              expect.objectContaining({ error: 'INVALID_INPUT' }),
            );
            expect(expressResponse.json).toEqual(
              expect.objectContaining({ error: 'INVALID_INPUT' }),
            );
          }
        },
      },
      {
        name: 'POST /v1/transactions/bulk forwards metadata for every item',
        run: async () => {
          const buildPayload = (framework: string) => ({
            transactions: [
              {
                ledger_id: '00000000-0000-4000-8000-000000000001',
                reference: `bulk-metadata-${framework}-nested`,
                currency: 'USD',
                metadata: { provider: { framework }, tags: ['bulk'] },
                entries: [
                  {
                    account_id: '00000000-0000-4000-8000-000000000101',
                    signed_amount_minor: '100',
                    currency: 'USD',
                  },
                  {
                    account_id: '00000000-0000-4000-8000-000000000102',
                    signed_amount_minor: '-100',
                    currency: 'USD',
                  },
                ],
              },
              {
                ledger_id: '00000000-0000-4000-8000-000000000001',
                reference: `bulk-metadata-${framework}-empty`,
                currency: 'USD',
                metadata: {},
                entries: [
                  {
                    account_id: '00000000-0000-4000-8000-000000000101',
                    signed_amount_minor: '50',
                    currency: 'USD',
                  },
                  {
                    account_id: '00000000-0000-4000-8000-000000000102',
                    signed_amount_minor: '-50',
                    currency: 'USD',
                  },
                ],
              },
            ],
          });
          const [fastifyResponse, expressResponse] = await Promise.all([
            requestFastify('POST', '/v1/transactions/bulk', buildPayload('fastify')),
            requestExpress('POST', '/v1/transactions/bulk', buildPayload('express')),
          ]);
          expect(fastifyResponse.status).toBe(201);
          expect(expressResponse.status).toBe(201);
          expect(fastifyResponse.json).toEqual(
            expect.objectContaining({ created_count: 2, idempotent_count: 0 }),
          );
          expect(expressResponse.json).toEqual(
            expect.objectContaining({ created_count: 2, idempotent_count: 0 }),
          );
          expect(fakeLedgerService.metadataFor('bulk-metadata-fastify-nested')).toEqual({
            provider: { framework: 'fastify' },
            tags: ['bulk'],
          });
          expect(fakeLedgerService.metadataFor('bulk-metadata-fastify-empty')).toEqual({});
          expect(fakeLedgerService.metadataFor('bulk-metadata-express-nested')).toEqual({
            provider: { framework: 'express' },
            tags: ['bulk'],
          });
          expect(fakeLedgerService.metadataFor('bulk-metadata-express-empty')).toEqual({});
        },
      },
      {
        name: 'GET transaction list and detail preserve metadata parity',
        run: async () => {
          const transactionId = '00000000-0000-4000-8000-000000000301';
          const [fastifyList, expressList] = await Promise.all([
            requestFastify('GET', '/v1/transactions'),
            requestExpress('GET', '/v1/transactions'),
          ]);
          expect(fastifyList.status).toBe(200);
          expect(expressList).toEqual(fastifyList);
          expect(fastifyList.json).toEqual(
            expect.objectContaining({
              data: [expect.objectContaining({ metadata: { provider: { payment_id: 'read-1' } } })],
            }),
          );

          const [fastifyDetail, expressDetail] = await Promise.all([
            requestFastify('GET', `/v1/transactions/${transactionId}`),
            requestExpress('GET', `/v1/transactions/${transactionId}`),
          ]);
          expect(fastifyDetail.status).toBe(200);
          expect(expressDetail).toEqual(fastifyDetail);
          expect(fastifyDetail.json).toEqual(
            expect.objectContaining({ metadata: { provider: { payment_id: 'read-1' } } }),
          );
        },
      },
      {
        name: 'POST /v1/transactions domain and unexpected error parity',
        run: async () => {
          const buildPayload = (reference: string) => ({
            ledger_id: '00000000-0000-4000-8000-000000000001',
            reference,
            currency: 'USD',
            entries: [
              {
                account_id: '00000000-0000-4000-8000-000000000101',
                signed_amount_minor: '100',
                currency: 'USD',
              },
              {
                account_id: '00000000-0000-4000-8000-000000000102',
                signed_amount_minor: '-100',
                currency: 'USD',
              },
            ],
          });

          const [fastifyDomain, expressDomain] = await Promise.all([
            requestFastify('POST', '/v1/transactions', buildPayload('unbalanced-fastify')),
            requestExpress('POST', '/v1/transactions', buildPayload('unbalanced-express')),
          ]);
          expect(fastifyDomain).toEqual({
            status: 400,
            json: {
              error: 'UNBALANCED_TRANSACTION',
              message: 'total debits must equal total credits',
            },
          });
          expect(expressDomain).toEqual(fastifyDomain);

          const [fastifyUnexpected, expressUnexpected] = await Promise.all([
            requestFastify('POST', '/v1/transactions', buildPayload('unexpected-fastify')),
            requestExpress('POST', '/v1/transactions', buildPayload('unexpected-express')),
          ]);
          expect(fastifyUnexpected).toEqual({
            status: 500,
            json: { error: 'INTERNAL_ERROR', message: 'Internal server error' },
          });
          expect(expressUnexpected).toEqual(fastifyUnexpected);
        },
      },
      {
        name: 'transaction reversal and correction response parity',
        run: async () => {
          const transactionId = '00000000-0000-4000-8000-000000000300';
          const buildCorrectionPayload = (suffix: string) => ({
            reversal_reference: `correct-reversal-${suffix}`,
            corrected_reference: `correct-replacement-${suffix}`,
            entries: [
              {
                account_id: '00000000-0000-4000-8000-000000000101',
                signed_amount_minor: '100',
                currency: 'USD',
              },
              {
                account_id: '00000000-0000-4000-8000-000000000102',
                signed_amount_minor: '-100',
                currency: 'USD',
              },
            ],
          });
          const [fastifyReverse, expressReverse] = await Promise.all([
            requestFastify('POST', `/v1/transactions/${transactionId}/reverse`, {
              reference: 'reverse-fastify',
            }),
            requestExpress('POST', `/v1/transactions/${transactionId}/reverse`, {
              reference: 'reverse-express',
            }),
          ]);
          expect(expressReverse.status).toBe(fastifyReverse.status);
          expect(expressReverse.json).toEqual(fastifyReverse.json);

          const [fastifyCorrect, expressCorrect] = await Promise.all([
            requestFastify(
              'POST',
              `/v1/transactions/${transactionId}/correct`,
              buildCorrectionPayload('fastify'),
            ),
            requestExpress(
              'POST',
              `/v1/transactions/${transactionId}/correct`,
              buildCorrectionPayload('express'),
            ),
          ]);
          expect(expressCorrect.status).toBe(fastifyCorrect.status);
          expect(expressCorrect.json).toEqual(fastifyCorrect.json);
        },
      },
      {
        name: 'new endpoint negative validation parity',
        run: async () => {
          const invalidRequests = [
            {
              method: 'GET' as const,
              url: '/v1/accounts/00000000-0000-4000-8000-000000000101/balance-as-of?at=invalid',
            },
            {
              method: 'GET' as const,
              url: '/v1/accounts/00000000-0000-4000-8000-000000000101/balance-history?from=invalid&to=invalid&limit=201',
            },
            {
              method: 'GET' as const,
              url: '/v1/accounts/00000000-0000-4000-8000-000000000101/statement?from=invalid&as_of=invalid',
            },
            {
              method: 'GET' as const,
              url: '/v1/accounts/00000000-0000-4000-8000-000000000101/credit-statement?from=2026-01-01T00%3A00%3A00.000Z&as_of=2026-01-02T00%3A00%3A00.000Z&grant_id=invalid',
            },
            { method: 'POST' as const, url: '/v1/holds', payload: {} },
            { method: 'GET' as const, url: '/v1/holds/not-a-uuid' },
            { method: 'GET' as const, url: '/v1/holds/not-a-uuid/entries' },
            { method: 'GET' as const, url: '/v1/holds/not-a-uuid/captures' },
            { method: 'GET' as const, url: '/v1/holds/not-a-uuid/credit-allocations' },
            {
              method: 'POST' as const,
              url: '/v1/holds/not-a-uuid/void',
              payload: { reference: 'void' },
            },
            { method: 'POST' as const, url: '/v1/credit-grants', payload: {} },
            {
              method: 'POST' as const,
              url: '/v1/credit-grants/00000000-0000-4000-8000-000000000901/refund',
              payload: { reference: 'refund', amount_minor: '0' },
            },
            {
              method: 'POST' as const,
              url: '/v1/credit-grants/not-a-uuid/refund',
              payload: { reference: 'refund', amount_minor: '1' },
            },
            { method: 'POST' as const, url: '/v1/adjustments/credit', payload: {} },
            {
              method: 'POST' as const,
              url: '/v1/adjustments/debit',
              payload: { ...adjustmentPayload, actor_id: ' ', unexpected: true },
            },
            {
              method: 'POST' as const,
              url: '/v1/adjustments/debit',
              payload: { ...adjustmentPayload, amount_minor: '-1' },
            },
            {
              method: 'POST' as const,
              url: '/v1/adjustments/credit',
              payload: { ...adjustmentPayload, attributes: ['not-an-object'] },
            },
            {
              method: 'POST' as const,
              url: '/v1/credit-grants/00000000-0000-4000-8000-000000000901/reversal',
              payload: {},
            },
            { method: 'GET' as const, url: '/v1/credit-grants/not-a-uuid/allocations' },
            { method: 'GET' as const, url: '/v1/transactions/not-a-uuid/credit-allocations' },
            { method: 'GET' as const, url: '/v1/accounts/not-a-uuid/credit-balance' },
            {
              method: 'POST' as const,
              url: '/v1/credit-grants/expiration/run',
              payload: { as_of: '2027-01-01T00:00:00.000Z', limit: 101 },
            },
            {
              method: 'POST' as const,
              url: '/v1/holds/00000000-0000-4000-8000-000000000400/commit',
              payload: { reference: 'commit', amount_minor: '0' },
            },
            {
              method: 'POST' as const,
              url: '/v1/reconciliation/matching-rules',
              payload: { name: 'rule', criteria: [] },
            },
            {
              method: 'POST' as const,
              url: '/v1/reconciliation/external-records',
              payload: { source: 'bank', records: [] },
            },
            {
              method: 'POST' as const,
              url: '/v1/reconciliation/runs',
              payload: {
                ledger_id: '00000000-0000-4000-8000-000000000001',
                upload_id: '00000000-0000-4000-8000-000000000500',
                strategy: 'one_to_one',
                matching_rule_ids: [],
              },
            },
          ];

          for (const invalidRequest of invalidRequests) {
            const [fastifyResponse, expressResponse] = await Promise.all([
              requestFastify(invalidRequest.method, invalidRequest.url, invalidRequest.payload),
              requestExpress(invalidRequest.method, invalidRequest.url, invalidRequest.payload),
            ]);
            expect(fastifyResponse.status).toBe(400);
            expect(expressResponse.status).toBe(400);
            expect(fastifyResponse.json).toEqual(
              expect.objectContaining({ error: 'INVALID_INPUT' }),
            );
            expect(expressResponse.json).toEqual(
              expect.objectContaining({ error: 'INVALID_INPUT' }),
            );
          }

          const invalidCursorUrl =
            '/v1/accounts/00000000-0000-4000-8000-000000000101/statement?from=2026-01-01T00%3A00%3A00.000Z&as_of=2026-01-02T00%3A00%3A00.000Z&cursor=invalid-cursor';
          const [fastifyCursor, expressCursor] = await Promise.all([
            requestFastify('GET', invalidCursorUrl),
            requestExpress('GET', invalidCursorUrl),
          ]);
          expect(fastifyCursor).toEqual({
            status: 400,
            json: { error: 'INVARIANT_VIOLATION', message: 'Invalid cursor' },
          });
          expect(expressCursor).toEqual(fastifyCursor);
        },
      },
    ];

    for (const check of checks) {
      await check.run();
    }
  });

  it('forwards scoped list filters, pagination, and fixed query values through both adapters', async () => {
    const id = '00000000-0000-4000-8000-000000000101';
    const runIdV7 = '01900000-0000-7000-8000-000000000001';
    const grantId = '00000000-0000-4000-8000-000000000901';
    const transactionId = '00000000-0000-4000-8000-000000000300';
    const date = '2026-01-01T00:00:00.1200Z';
    const exactDate = { exactTimestamp: '2026-01-01T00:00:00.120000Z' };
    const where = (field: string, operator: string, value: unknown) =>
      `where=${encodeURIComponent(JSON.stringify({ [field]: { [operator]: value } }))}`;
    const cases: Array<{
      endpoint: string;
      path: string;
      expected: Record<string, unknown>;
    }> = [
      {
        endpoint: 'accounts',
        path: `/v1/accounts?ledger_id=${id}&limit=7&cursor=opaque&${where('balance_minor', 'gte', '25')}`,
        expected: {
          tenantId,
          limit: 7,
          cursor: 'opaque',
          ledgerId: id,
          where: { balanceMinor: { gte: 25n } },
        },
      },
      {
        endpoint: 'transactions',
        path: `/v1/transactions?ledger_id=${id}&limit=7&cursor=opaque&${where('created_at', 'gte', date)}`,
        expected: {
          tenantId,
          limit: 7,
          cursor: 'opaque',
          ledgerId: id,
          where: { createdAt: { gte: exactDate } },
        },
      },
      {
        endpoint: 'entries',
        path: `/v1/entries?limit=7&cursor=opaque&${where('signed_amount_minor', 'gte', '-25')}`,
        expected: {
          tenantId,
          limit: 7,
          cursor: 'opaque',
          where: { signedAmountMinor: { gte: -25n } },
        },
      },
      {
        endpoint: 'ledgers',
        path: `/v1/ledgers?limit=7&cursor=opaque&${where('created_at', 'gte', date)}`,
        expected: {
          tenantId,
          limit: 7,
          cursor: 'opaque',
          where: { createdAt: { gte: exactDate } },
        },
      },
      {
        endpoint: 'api-keys',
        path: `/v1/admin/api-keys?limit=7&cursor=opaque&${where('role', 'eq', 'ADMIN')}`,
        expected: {
          auth: {
            tenantId,
            apiKeyId: '00000000-0000-4000-8000-000000000001',
            role: ApiKeyRole.ADMIN,
          },
          limit: 7,
          cursor: 'opaque',
          where: { role: { eq: 'ADMIN' } },
        },
      },
      {
        endpoint: 'reconciliation-rules',
        path: `/v1/reconciliation/matching-rules?limit=7&cursor=opaque&${where('created_at', 'gte', date)}`,
        expected: {
          tenantId,
          limit: 7,
          cursor: 'opaque',
          where: { createdAt: { gte: exactDate } },
        },
      },
      {
        endpoint: 'reconciliation-uploads',
        path: `/v1/reconciliation/uploads?limit=7&cursor=opaque&${where('source', 'eq', 'bank')}`,
        expected: { tenantId, limit: 7, cursor: 'opaque', where: { source: { eq: 'bank' } } },
      },
      {
        endpoint: 'reconciliation-runs',
        path: `/v1/reconciliation/runs?limit=7&cursor=opaque&${where('status', 'eq', 'completed')}`,
        expected: { tenantId, limit: 7, cursor: 'opaque', where: { status: { eq: 'completed' } } },
      },
      {
        endpoint: 'reconciliation-results',
        path: `/v1/reconciliation/runs/${runIdV7}/results?limit=7&cursor=opaque&${where('status', 'eq', 'matched')}`,
        expected: {
          tenantId,
          runId: runIdV7,
          limit: 7,
          cursor: 'opaque',
          where: { status: { eq: 'matched' } },
        },
      },
      {
        endpoint: 'credit-grants',
        path: `/v1/credit-grants?account_id=${id}&reference=ref-1&external_reference=ext-1&limit=7&cursor=opaque&${where('created_at', 'gte', date)}`,
        expected: {
          tenantId,
          accountId: id,
          reference: 'ref-1',
          externalReference: 'ext-1',
          limit: 7,
          cursor: 'opaque',
          where: { createdAt: { gte: exactDate } },
        },
      },
      {
        endpoint: 'grant-allocations',
        path: `/v1/credit-grants/${grantId}/allocations?limit=7&cursor=opaque&${where('amount_minor', 'gte', '25')}`,
        expected: {
          tenantId,
          grantId,
          limit: 7,
          cursor: 'opaque',
          where: { amountMinor: { gte: 25n } },
        },
      },
      {
        endpoint: 'transaction-allocations',
        path: `/v1/transactions/${transactionId}/credit-allocations?limit=7&cursor=opaque&${where('created_at', 'gte', date)}`,
        expected: {
          tenantId,
          transactionId,
          limit: 7,
          cursor: 'opaque',
          where: { createdAt: { gte: exactDate } },
        },
      },
      {
        endpoint: 'credit-lots',
        path: `/v1/accounts/${id}/credit-lots?limit=7&cursor=opaque&${where('created_at', 'gte', date)}`,
        expected: {
          tenantId,
          accountId: id,
          limit: 7,
          cursor: 'opaque',
          where: { createdAt: { gte: exactDate } },
        },
      },
      {
        endpoint: 'balance-history',
        path: `/v1/accounts/${id}/balance-history?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}&limit=7&cursor=opaque&${where('posted_minor', 'gte', '25')}`,
        expected: {
          tenantId,
          accountId: id,
          from: new Date(date),
          to: new Date(date),
          limit: 7,
          cursor: 'opaque',
          where: { postedMinor: { gte: 25n } },
        },
      },
      {
        endpoint: 'holds',
        path: `/v1/holds?limit=7&cursor=opaque&where=${encodeURIComponent(JSON.stringify({ state: { eq: 'HELD' }, account_id: { eq: id } }))}`,
        expected: {
          tenantId,
          limit: 7,
          cursor: 'opaque',
          where: { state: { eq: 'HELD' }, accountId: { eq: id } },
        },
      },
      {
        endpoint: 'hold-entries',
        path: `/v1/holds/${holdId}/entries?limit=7&cursor=opaque&${where('signed_amount_minor', 'gte', '-25')}`,
        expected: {
          tenantId,
          holdId,
          limit: 7,
          cursor: 'opaque',
          where: { signedAmountMinor: { gte: -25n } },
        },
      },
      {
        endpoint: 'hold-captures',
        path: `/v1/holds/${holdId}/captures?limit=7&cursor=opaque&${where('amount_minor', 'gte', '25')}`,
        expected: {
          tenantId,
          holdId,
          limit: 7,
          cursor: 'opaque',
          where: { amountMinor: { gte: 25n } },
        },
      },
      {
        endpoint: 'hold-credit-allocations',
        path: `/v1/holds/${holdId}/credit-allocations?limit=7&cursor=opaque&${where('created_at', 'gte', date)}`,
        expected: {
          tenantId,
          holdId,
          limit: 7,
          cursor: 'opaque',
          where: { createdAt: { gte: exactDate } },
        },
      },
    ];

    for (const { endpoint, path, expected } of cases) {
      for (const request of [requestFastify, requestExpress]) {
        listObservations.clear();
        const response = await request('GET', path);
        expect(response.status).toBe(200);
        expect(listObservations.get(endpoint)).toEqual([expected]);
      }
    }

    for (const { endpoint, path, expected } of cases) {
      const queryStart = Math.max(path.indexOf('?where='), path.indexOf('&where='));
      const prefix = path.slice(0, queryStart);
      const separator = prefix.includes('?') ? '&' : '?';
      for (const suffix of ['', `${separator}where=${encodeURIComponent('{}')}`]) {
        for (const request of [requestFastify, requestExpress]) {
          listObservations.clear();
          const response = await request('GET', `${prefix}${suffix}`);
          expect(response.status).toBe(200);
          expect(listObservations.get(endpoint)).toEqual([{ ...expected, where: undefined }]);
        }
      }
    }

    const privateField = `where=${encodeURIComponent(JSON.stringify({ tenant_id: { eq: tenantId } }))}`;
    const invalidWhereQueries = [
      privateField,
      `where=${encodeURIComponent(JSON.stringify({ key_hash: { eq: 'sensitive-hash' } }))}`,
      `where=${encodeURIComponent(JSON.stringify({ candidate_transaction_ids: { eq: ['id'] } }))}`,
      `where=${encodeURIComponent(JSON.stringify({ unknown_field: { eq: 'x' } }))}`,
      `where=${encodeURIComponent(JSON.stringify({ id: { eq: 'not-a-uuid' } }))}`,
      `where=${encodeURIComponent(JSON.stringify({ created_at: { gt: 'not-a-date' } }))}`,
      `where=${encodeURIComponent(JSON.stringify({ amount_minor: { eq: '1.5' } }))}`,
      `where=${encodeURIComponent(JSON.stringify({ state: { unsupported: 'HELD' } }))}`,
      'where=%7Bbad',
      'where=%7B%7D&where=%7B%7D',
      `where=${'x'.repeat(8193)}`,
    ];
    for (const { endpoint, path } of cases) {
      const queryStart = Math.max(path.indexOf('?where='), path.indexOf('&where='));
      const prefix = path.slice(0, queryStart);
      const separator = prefix.includes('?') ? '&' : '?';
      for (const invalidWhere of invalidWhereQueries) {
        for (const request of [requestFastify, requestExpress]) {
          listObservations.clear();
          const response = await request('GET', `${prefix}${separator}${invalidWhere}`);
          expect(response.status).toBe(400);
          expect(listObservations.has(endpoint)).toBeFalse();
        }
      }
    }

    for (const path of [
      '/v1/ledgers',
      '/v1/admin/api-keys',
      '/v1/reconciliation/matching-rules',
      '/v1/reconciliation/uploads',
      '/v1/reconciliation/runs',
      `/v1/reconciliation/uploads/${holdId}/records`,
      `/v1/reconciliation/runs/${id}/results`,
    ]) {
      for (const request of [requestFastify, requestExpress]) {
        listObservations.clear();
        const response = await request('GET', `${path}?unexpected=1`);
        expect(response.status).toBe(400);
        expect(listObservations.size).toBe(0);
      }
    }

    const defaultPagePaths = [
      ['/v1/ledgers', 'ledgers'],
      ['/v1/admin/api-keys', 'api-keys'],
      ['/v1/reconciliation/matching-rules', 'reconciliation-rules'],
      ['/v1/reconciliation/uploads', 'reconciliation-uploads'],
      ['/v1/reconciliation/runs', 'reconciliation-runs'],
      [`/v1/reconciliation/runs/${runIdV7}/results`, 'reconciliation-results'],
    ] as const;
    for (const [path, endpoint] of defaultPagePaths) {
      for (const request of [requestFastify, requestExpress]) {
        listObservations.clear();
        const response = await request('GET', path);
        expect(response.status).toBe(200);
        expect(response.json).toEqual({ data: [], next_cursor: null });
        const observation = listObservations.get(endpoint)?.[0] as Record<string, unknown>;
        expect(observation).toMatchObject({ limit: 50, cursor: undefined, where: undefined });
      }
      for (const request of [requestFastify, requestExpress]) {
        listObservations.clear();
        const response = await request('GET', `${path}?limit=201`);
        expect(response.status).toBe(400);
        expect(listObservations.has(endpoint)).toBeFalse();
      }
    }

    for (const request of [requestFastify, requestExpress]) {
      listObservations.clear();
      const response = await request(
        'GET',
        `/v1/reconciliation/uploads/00000000-0000-4000-8000-000000000500/records?limit=7&cursor=opaque`,
      );
      expect(response.status).toBe(200);
      expect(response.json).toEqual({
        data: [
          {
            id: '00000000-0000-4000-8000-000000000501',
            external_id: 'bank-row-1',
            amount_minor: '1200',
            currency: 'USD',
            reference: 'invoice-1',
            description: null,
            occurred_at: '2026-01-01T00:00:00.000Z',
          },
        ],
        next_cursor: null,
      });
      expect(JSON.stringify(response.json)).not.toContain('account_number');
      expect(listObservations.get('reconciliation-upload-records')?.[0]).toMatchObject({
        tenantId,
        uploadId: '00000000-0000-4000-8000-000000000500',
        limit: 7,
        cursor: 'opaque',
      });
    }

    const holdDefaultPagePaths = [
      ['/v1/holds', 'holds'],
      [`/v1/holds/${holdId}/entries`, 'hold-entries'],
      [`/v1/holds/${holdId}/captures`, 'hold-captures'],
      [`/v1/holds/${holdId}/credit-allocations`, 'hold-credit-allocations'],
    ] as const;
    for (const [path, endpoint] of holdDefaultPagePaths) {
      for (const request of [requestFastify, requestExpress]) {
        listObservations.clear();
        const response = await request('GET', path);
        expect(response.status).toBe(200);
        const observation = listObservations.get(endpoint)?.[0] as Record<string, unknown>;
        expect(observation).toMatchObject({
          tenantId,
          limit: 50,
          cursor: undefined,
          where: undefined,
        });
        if (endpoint !== 'holds') expect(observation.holdId).toBe(holdId);
      }
      for (const request of [requestFastify, requestExpress]) {
        listObservations.clear();
        const response = await request('GET', `${path}?limit=201`);
        expect(response.status).toBe(400);
        expect(listObservations.has(endpoint)).toBeFalse();
      }
    }

    const mixedPrecisionWhere = `where=${encodeURIComponent(
      JSON.stringify({
        created_at: {
          in: ['2026-01-01T00:00:00.120Z', '2026-01-01T00:00:00.1234Z'],
        },
      }),
    )}`;
    for (const request of [requestFastify, requestExpress]) {
      listObservations.clear();
      const response = await request('GET', `/v1/transactions?${mixedPrecisionWhere}`);
      expect(response.status).toBe(200);
      expect(listObservations.get('transactions')?.[0]).toMatchObject({
        where: {
          createdAt: {
            in: [new Date(date), { exactTimestamp: '2026-01-01T00:00:00.123400Z' }],
          },
        },
      });
    }

    const missingRunPath = '/v1/reconciliation/runs/01900000-0000-7000-8000-000000000999/results';
    const invalidRunPath = '/v1/reconciliation/runs/not-a-uuid/results';
    const missingUploadPath = '/v1/reconciliation/uploads/01900000-0000-7000-8000-000000000999';
    const invalidUploadPath = '/v1/reconciliation/uploads/not-a-uuid/records';
    for (const request of [requestFastify, requestExpress]) {
      listObservations.clear();
      const missing = await request('GET', missingRunPath);
      expect(missing.status).toBe(404);
      expect(missing.json).toMatchObject({ error: 'RECONCILIATION_RUN_NOT_FOUND' });
      expect(JSON.stringify(missing.json)).not.toContain('database');

      const missingUpload = await request('GET', missingUploadPath);
      expect(missingUpload.status).toBe(404);
      expect(missingUpload.json).toMatchObject({ error: 'RECONCILIATION_UPLOAD_NOT_FOUND' });
      expect(JSON.stringify(missingUpload.json)).not.toContain('database');

      const invalidUpload = await request('GET', invalidUploadPath);
      expect(invalidUpload.status).toBe(400);

      listObservations.clear();
      const invalid = await request('GET', invalidRunPath);
      expect(invalid.status).toBe(400);
      expect(listObservations.has('reconciliation-results')).toBeFalse();
    }
  });

  it.each([
    '01900000-0000-7000-8000-000000000001',
    '00000000-0000-9000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('accepts PostgreSQL UUID filter %s in both adapters', async (accountIdV7) => {
    listObservations.clear();
    const validPath = `/v1/credit-grants?account_id=${accountIdV7}`;
    const [fastifyValid, expressValid] = await Promise.all([
      requestFastify('GET', validPath),
      requestExpress('GET', validPath),
    ]);
    expect(fastifyValid.status).toBe(200);
    expect(expressValid).toEqual(fastifyValid);
    expect(listObservations.get('credit-grants')).toHaveLength(2);
    expect(listObservations.get('credit-grants')).toEqual([
      {
        tenantId,
        limit: 50,
        cursor: undefined,
        accountId: accountIdV7,
        reference: undefined,
        externalReference: undefined,
        where: undefined,
      },
      {
        tenantId,
        limit: 50,
        cursor: undefined,
        accountId: accountIdV7,
        reference: undefined,
        externalReference: undefined,
        where: undefined,
      },
    ]);

    for (const invalidQuery of ['account_id=not-a-uuid', 'reference=%20%20']) {
      listObservations.clear();
      const path = `/v1/credit-grants?${invalidQuery}`;
      const [fastifyInvalid, expressInvalid] = await Promise.all([
        requestFastify('GET', path),
        requestExpress('GET', path),
      ]);
      expect(fastifyInvalid.status).toBe(400);
      expect(expressInvalid).toEqual(fastifyInvalid);
      expect(listObservations.has('credit-grants')).toBeFalse();
    }
  });

  it('serializes hold summaries and child reads consistently, and safely handles missing parents', async () => {
    const requests = [
      {
        path: `/v1/holds/${holdId}`,
        expected: {
          id: holdId,
          ledger_id: '00000000-0000-4000-8000-000000000001',
          reference: 'hold-parity',
          currency: 'USD',
          description: null,
          state: 'HELD',
          original_amount_minor: '125',
          remaining_amount_minor: '75',
          created_at: '2026-01-01T00:00:00.000Z',
          applied_at: null,
          voided_at: null,
        },
      },
      {
        path: `/v1/holds/${holdId}/entries`,
        expected: {
          data: [
            {
              id: '00000000-0000-4000-8000-000000000412',
              account_id: '00000000-0000-4000-8000-000000000413',
              signed_amount_minor: '-125',
              currency: 'USD',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
          next_cursor: null,
        },
      },
      {
        path: `/v1/holds/${holdId}/captures`,
        expected: {
          data: [
            {
              id: '00000000-0000-4000-8000-000000000414',
              reference: 'hold-capture-1',
              amount_minor: '50',
              currency: 'USD',
              created_at: '2026-01-02T00:00:00.000Z',
            },
          ],
          next_cursor: null,
        },
      },
      {
        path: `/v1/holds/${holdId}/credit-allocations`,
        expected: {
          data: [
            {
              id: '00000000-0000-4000-8000-000000000415',
              hold_entry_id: '00000000-0000-4000-8000-000000000412',
              account_id: '00000000-0000-4000-8000-000000000413',
              grant_id: '00000000-0000-4000-8000-000000000416',
              amount_minor: '25',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
          next_cursor: null,
        },
      },
    ];
    for (const { path, expected } of requests) {
      const [fastifyResponse, expressResponse] = await Promise.all([
        requestFastify('GET', path),
        requestExpress('GET', path),
      ]);
      expect(fastifyResponse.status).toBe(200);
      expect(expressResponse.status).toBe(200);
      expect(fastifyResponse.json).toEqual(expected);
      expect(expressResponse.json).toEqual(expected);
    }

    for (const request of [requestFastify, requestExpress]) {
      for (const path of [
        `/v1/holds/${unknownHoldId}`,
        `/v1/holds/${unknownHoldId}/entries`,
        `/v1/holds/${unknownHoldId}/captures`,
        `/v1/holds/${unknownHoldId}/credit-allocations`,
      ]) {
        const response = await request('GET', path);
        expect(response.status).toBe(404);
        expect(response.json).toMatchObject({ error: 'HOLD_NOT_FOUND' });
        expect(JSON.stringify(response.json)).not.toContain('database');
      }

      for (const path of [
        `/v1/holds/${emptyHoldId}/entries`,
        `/v1/holds/${emptyHoldId}/captures`,
        `/v1/holds/${emptyHoldId}/credit-allocations`,
      ]) {
        const response = await request('GET', path);
        expect(response.status).toBe(200);
        expect(response.json).toEqual({ data: [], next_cursor: null });
      }
    }
  });

  it('keeps credit grant creation and lot response identical across adapters', async () => {
    const payload = {
      ledger_id: '00000000-0000-4000-8000-000000000910',
      account_id: '00000000-0000-4000-8000-000000000911',
      funding_account_id: '00000000-0000-4000-8000-000000000912',
      reference: 'parity-grant',
      amount_minor: '100',
      expires_at: '2027-01-01T00:00:00.000Z',
    };
    const [fastifyCreate, expressCreate] = await Promise.all([
      requestFastify('POST', '/v1/credit-grants', payload),
      requestExpress('POST', '/v1/credit-grants', payload),
    ]);
    expect(fastifyCreate.status).toBe(201);
    expect(expressCreate).toEqual(fastifyCreate);
    const grantPath = '/v1/credit-grants/00000000-0000-4000-8000-000000000901';
    const [fastifyRead, expressRead] = await Promise.all([
      requestFastify('GET', grantPath),
      requestExpress('GET', grantPath),
    ]);
    expect(expressRead).toEqual(fastifyRead);
    const [fastifyReverse, expressReverse] = await Promise.all([
      requestFastify('POST', `${grantPath}/reversal`, { reference: 'parity-reversal' }),
      requestExpress('POST', `${grantPath}/reversal`, { reference: 'parity-reversal' }),
    ]);
    expect(fastifyReverse.status).toBe(201);
    expect(expressReverse).toEqual(fastifyReverse);
    const path = `/v1/accounts/${payload.account_id}/credit-balance`;
    const [fastifyBalance, expressBalance] = await Promise.all([
      requestFastify('GET', path),
      requestExpress('GET', path),
    ]);
    expect(fastifyBalance.status).toBe(200);
    expect(expressBalance).toEqual(fastifyBalance);
    const [fastifyLineage, expressLineage] = await Promise.all([
      requestFastify('GET', `${grantPath}/allocations`),
      requestExpress('GET', `${grantPath}/allocations`),
    ]);
    expect(fastifyLineage.status).toBe(200);
    expect(expressLineage).toEqual(fastifyLineage);
    expect(fastifyLineage.json).toEqual({ data: [], next_cursor: null });
    for (const boundedPath of [
      `/v1/credit-grants?account_id=${payload.account_id}&reference=parity-grant&limit=10`,
      `/v1/accounts/${payload.account_id}/credit-lots?limit=10&cursor=abc`,
      `/v1/transactions/${payload.account_id}/credit-allocations?limit=10`,
      `/v1/accounts/${payload.account_id}/statement?from=2026-01-01T00%3A00%3A00.000Z&as_of=2026-01-02T00%3A00%3A00.000Z&limit=10`,
      `/v1/accounts/${payload.account_id}/credit-statement?from=2026-01-01T00%3A00%3A00.000Z&as_of=2026-01-02T00%3A00%3A00.000Z&grant_id=00000000-0000-4000-8000-000000000901&limit=10`,
    ]) {
      const [fastifyPage, expressPage] = await Promise.all([
        requestFastify('GET', boundedPath),
        requestExpress('GET', boundedPath),
      ]);
      expect(fastifyPage.status).toBe(200);
      expect(expressPage).toEqual(fastifyPage);
    }
    for (const invalidPath of [
      '/v1/credit-grants?limit=0',
      '/v1/credit-grants?limit=201',
      `/v1/accounts/${payload.account_id}/credit-lots?limit=abc`,
      `${grantPath}/allocations?cursor=`,
    ]) {
      const [fastifyInvalid, expressInvalid] = await Promise.all([
        requestFastify('GET', invalidPath),
        requestExpress('GET', invalidPath),
      ]);
      expect(fastifyInvalid.status).toBe(400);
      expect(expressInvalid.status).toBe(400);
    }
    const expirationPayload = { as_of: '2027-01-01T00:00:00.000Z', limit: 10 };
    for (const expirationPath of [
      '/v1/credit-grants/expiration/preview',
      '/v1/credit-grants/expiration/run',
    ]) {
      const [fastifyExpiration, expressExpiration] = await Promise.all([
        requestFastify('POST', expirationPath, expirationPayload),
        requestExpress('POST', expirationPath, expirationPayload),
      ]);
      expect(fastifyExpiration.status).toBe(200);
      expect(expressExpiration).toEqual(fastifyExpiration);
    }
  });

  it('keeps credit grant refunds identical across adapters', async () => {
    const path = '/v1/credit-grants/00000000-0000-4000-8000-000000000901/refund';
    for (const [reference, status] of [
      ['refund-1', 201],
      ['retry-refund-1', 200],
      ['conflict-refund-1', 409],
    ] as const) {
      const payload = { reference, amount_minor: '40' };
      const [fastifyRefund, expressRefund] = await Promise.all([
        requestFastify('POST', path, payload),
        requestExpress('POST', path, payload),
      ]);
      expect(fastifyRefund.status).toBe(status);
      expect(expressRefund).toEqual(fastifyRefund);
    }
  });

  it('keeps credit and debit adjustments identical across adapters', async () => {
    for (const [path, reference, status] of [
      ['/v1/adjustments/credit', 'adjustment-1', 201],
      ['/v1/adjustments/credit', 'retry-adjustment-1', 200],
      ['/v1/adjustments/debit', 'adjustment-2', 201],
      ['/v1/adjustments/debit', 'conflict-adjustment-2', 409],
    ] as const) {
      const payload = { ...adjustmentPayload, reference };
      const [fastifyAdjustment, expressAdjustment] = await Promise.all([
        requestFastify('POST', path, payload),
        requestExpress('POST', path, payload),
      ]);
      expect(fastifyAdjustment.status).toBe(status);
      expect(expressAdjustment).toEqual(fastifyAdjustment);
    }
  });

  it.each([
    'default',
    'custom',
    'host',
  ] as const)('uses %s Express JSON parsing after host middleware', async (mode) => {
    let serviceCalls = 0;
    let observedAmount: bigint | undefined;
    const services = {
      adjustments: {
        credit: async (input: { amountMinor: bigint }) => {
          serviceCalls += 1;
          observedAmount = input.amountMinor;
          return { transactionId: '00000000-0000-4000-8000-000000000906', created: true };
        },
      },
    } as unknown as ApplicationServices;
    const app = express();
    app.use((request, _response, next) => {
      Object.assign(request, {
        tenantId,
        apiKeyId: 'host-api-key',
        apiKeyRole: ApiKeyRole.ADMIN,
      });
      next();
    });
    let parserCalls = 0;
    const parser = express.json();
    const customParser: express.RequestHandler = (req, res, next) => {
      parserCalls += 1;
      parser(req, res, next);
    };
    if (mode === 'host') app.use(customParser);
    registerExpressLedgerAdapter(app, services, {
      authorizeAdjustment: false,
      jsonParser: mode === 'host' ? false : mode === 'custom' ? customParser : undefined,
    });

    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP address');
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/adjustments/credit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(adjustmentPayload),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        transaction_id: '00000000-0000-4000-8000-000000000906',
        created: true,
      });
      expect(observedAmount).toBe(25n);
      expect(serviceCalls).toBe(1);
      expect(parserCalls).toBe(mode === 'default' ? 0 : 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('maps Fastify route validation without host error-handler setup', async () => {
    const server = Fastify({
      ajv: {
        customOptions: {
          removeAdditional: false,
        },
      },
    });
    server.decorateRequest('tenantId');
    server.decorateRequest('apiKeyId');
    server.decorateRequest('apiKeyRole');
    registerFastifyLedgerAdapter(server, {} as ApplicationServices, {
      authorizeAdjustment: false,
    });

    try {
      for (const [method, url, payload, message] of [
        ['POST', '/v1/adjustments/credit', {}, 'Invalid request body'],
        ['POST', '/v1/credit-grants', {}, 'Invalid request body'],
        [
          'POST',
          '/v1/credit-grants/00000000-0000-4000-8000-000000000901/reversal',
          {},
          'Invalid request body',
        ],
        [
          'POST',
          '/v1/credit-grants/00000000-0000-4000-8000-000000000901/refund',
          { reference: 'refund', amount_minor: '0' },
          'Invalid request body',
        ],
        [
          'POST',
          '/v1/credit-grants/not-a-uuid/refund',
          { reference: 'refund', amount_minor: '1' },
          'Invalid path parameter',
        ],
        ['POST', '/v1/holds', {}, 'Invalid request body'],
        ['POST', '/v1/holds/not-a-uuid/void', undefined, 'Invalid path parameter'],
      ] as const) {
        const response = await server.inject({ method, url, payload });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: 'INVALID_INPUT', message });
      }
    } finally {
      await server.close();
    }
  });
});

describe('host rate limit and request size error parity', () => {
  it('returns matching host 429 and 413 responses before adapter services run', async () => {
    const retryAfterSeconds = 37;
    const requestTooLarge = { error: 'REQUEST_TOO_LARGE', message: 'Request too large' };
    let rejection: 429 | 413 | null = 429;
    let serviceCalls = 0;
    const services = {
      adjustments: {
        credit: async () => {
          serviceCalls += 1;
          return { transactionId: '00000000-0000-4000-8000-000000000906', created: true };
        },
      },
    } as unknown as ApplicationServices;

    const fastify = Fastify();
    fastify.decorateRequest('tenantId');
    fastify.decorateRequest('apiKeyId');
    fastify.decorateRequest('apiKeyRole');
    fastify.addHook('onRoute', (routeOptions) => {
      routeOptions.schema ??= {};
      const routeResponses = routeOptions.schema.response;
      routeOptions.schema.response = {
        ...defaultErrorResponses,
        ...(typeof routeResponses === 'object' && routeResponses !== null
          ? (routeResponses as Record<string, unknown>)
          : {}),
      };
    });
    fastify.addHook('onRequest', (request, reply, done) => {
      if (rejection === 429) {
        throw new RateLimitExceededError(retryAfterSeconds);
      }
      if (rejection === 413) {
        reply.code(413).send(requestTooLarge);
        return;
      }
      Object.assign(request, { tenantId, apiKeyId: 'host-api-key', apiKeyRole: ApiKeyRole.ADMIN });
      done();
    });
    fastify.setErrorHandler((error, _request, reply) => {
      const { statusCode, headers, body } = toHttpErrorPayload(error);
      if (headers) reply.headers(headers);
      reply.code(statusCode).send(body);
    });
    registerFastifyLedgerAdapter(fastify, services, { authorizeAdjustment: false });

    const expressApp = express();
    expressApp.use((request, response, next) => {
      if (rejection === 429) {
        next(new RateLimitExceededError(retryAfterSeconds));
        return;
      }
      if (rejection === 413) {
        response.status(413).json(requestTooLarge);
        return;
      }
      Object.assign(request, { tenantId, apiKeyId: 'host-api-key', apiKeyRole: ApiKeyRole.ADMIN });
      next();
    });
    registerExpressLedgerAdapter(expressApp, services, { authorizeAdjustment: false });
    expressApp.use(
      (
        error: unknown,
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => {
        const { statusCode, headers, body } = toHttpErrorPayload(error);
        if (headers) response.set(headers);
        response.status(statusCode).json(body);
      },
    );

    const requestExpress = async () => {
      const req = httpMocks.createRequest({
        method: 'POST',
        url: '/v1/adjustments/credit',
        body: adjustmentPayload,
        headers: { 'content-type': 'application/json' },
      });
      const res = httpMocks.createResponse({
        eventEmitter: (await import('node:events')).EventEmitter,
      });
      await new Promise<void>((resolve) => {
        (expressApp as unknown as (req: unknown, res: unknown, next: () => void) => void)(
          req,
          res,
          resolve,
        );
        if (res.writableEnded) resolve();
        else res.on('finish', resolve);
      });
      const body = res._getData() as string;
      return {
        status: res.statusCode,
        json: body.length ? JSON.parse(body) : null,
        retryAfter: res.getHeader('Retry-After'),
      };
    };

    try {
      for (const [status, body] of [
        [
          429,
          {
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Rate limit exceeded',
            retry_after_seconds: retryAfterSeconds,
          },
        ],
        [413, { error: 'REQUEST_TOO_LARGE', message: 'Request too large' }],
      ] as const) {
        rejection = status;
        const fastifyResponse = await fastify.inject({
          method: 'POST',
          url: '/v1/adjustments/credit',
          payload: adjustmentPayload,
        });
        const expressResponse = await requestExpress();
        expect(fastifyResponse.statusCode).toBe(status);
        expect(expressResponse.status).toBe(status);
        expect(JSON.parse(fastifyResponse.body)).toEqual(body);
        expect(expressResponse.json).toEqual(body);
        expect(fastifyResponse.headers['retry-after']).toBe(
          status === 429 ? String(retryAfterSeconds) : undefined,
        );
        expect(expressResponse.retryAfter).toBe(
          status === 429 ? String(retryAfterSeconds) : undefined,
        );
        if (status === 429) {
          expect(Number(fastifyResponse.headers['retry-after'])).toBe(body.retry_after_seconds);
          expect(Number(expressResponse.retryAfter)).toBe(body.retry_after_seconds);
        }
        expect(serviceCalls).toBe(0);
      }

      rejection = null;
      const [fastifyResponse, expressResponse] = await Promise.all([
        fastify.inject({
          method: 'POST',
          url: '/v1/adjustments/credit',
          payload: adjustmentPayload,
        }),
        requestExpress(),
      ]);
      expect(fastifyResponse.statusCode).toBe(201);
      expect(expressResponse.status).toBe(201);
      expect(JSON.parse(fastifyResponse.body)).toEqual(expressResponse.json);
      expect(serviceCalls).toBe(2);
    } finally {
      await fastify.close();
    }
  });

  it('maps RateLimitExceededError thrown by adapter authorization with matching headers', async () => {
    const retryAfterSeconds = 37;
    let serviceCalls = 0;
    const services = {
      adjustments: {
        credit: async () => {
          serviceCalls += 1;
          return { transactionId: '00000000-0000-4000-8000-000000000906', created: true };
        },
      },
    } as unknown as ApplicationServices;
    const authorizeAdjustment = () => {
      throw new RateLimitExceededError(retryAfterSeconds);
    };
    const fastify = Fastify();
    fastify.decorateRequest('tenantId');
    fastify.decorateRequest('apiKeyId');
    fastify.decorateRequest('apiKeyRole');
    fastify.addHook('onRequest', (request, _reply, done) => {
      Object.assign(request, { tenantId, apiKeyId: 'host-api-key', apiKeyRole: ApiKeyRole.ADMIN });
      done();
    });
    registerFastifyLedgerAdapter(fastify, services, { authorizeAdjustment });

    const expressApp = express();
    expressApp.use((request, _response, next) => {
      Object.assign(request, { tenantId, apiKeyId: 'host-api-key', apiKeyRole: ApiKeyRole.ADMIN });
      next();
    });
    registerExpressLedgerAdapter(expressApp, services, { authorizeAdjustment });

    try {
      const fastifyResponse = await fastify.inject({
        method: 'POST',
        url: '/v1/adjustments/credit',
        payload: adjustmentPayload,
      });
      const req = httpMocks.createRequest({
        method: 'POST',
        url: '/v1/adjustments/credit',
        body: adjustmentPayload,
        headers: { 'content-type': 'application/json' },
      });
      const res = httpMocks.createResponse({
        eventEmitter: (await import('node:events')).EventEmitter,
      });
      await new Promise<void>((resolve, reject) => {
        res.on('finish', resolve);
        expressApp(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
      });
      const expected = {
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded',
        retry_after_seconds: retryAfterSeconds,
      };
      expect(fastifyResponse.statusCode).toBe(429);
      expect(JSON.parse(fastifyResponse.body)).toEqual(expected);
      expect(fastifyResponse.headers['retry-after']).toBe(String(retryAfterSeconds));
      expect(res.statusCode).toBe(429);
      expect(res._getJSONData()).toEqual(expected);
      expect(res.getHeader('Retry-After')).toBe(String(retryAfterSeconds));
      expect(serviceCalls).toBe(0);
    } finally {
      await fastify.close();
    }
  });
});

// Host authentication and policy use the public adapter callback API.
describe('host adjustment authorization parity', () => {
  type Principal = {
    tenantId: string;
    apiKeyId: string;
    apiKeyRole: ApiKeyRole;
    effectiveActorId: string;
    allowedDirections: readonly ('credit' | 'debit')[];
  };
  const servicePrincipal: Principal = {
    tenantId,
    apiKeyId: 'service-key-1',
    apiKeyRole: ApiKeyRole.SERVICE,
    effectiveActorId: 'service:billing',
    allowedDirections: ['credit', 'debit'],
  };
  const paths = ['/v1/adjustments/credit', '/v1/adjustments/debit'] as const;

  const createHosts = (
    resolvePrincipal: () => Promise<Principal | undefined>,
    override?: AdjustmentAuthorizationHook<object> | false,
  ) => {
    const calls: [
      { direction: string; input: CreateAdjustmentInput }[],
      { direction: string; input: CreateAdjustmentInput }[],
    ] = [[], []];
    const policyCalls: [unknown[], unknown[]] = [[], []];
    const principals = new WeakMap<object, Principal>();
    const authenticate = async (request: object) => {
      const principal = await resolvePrincipal();
      if (principal) {
        principals.set(request, principal);
        Object.assign(request, {
          tenantId: principal.tenantId,
          apiKeyId: principal.apiKeyId,
          apiKeyRole: principal.apiKeyRole,
        });
      }
    };
    const makeServices = (observed: (typeof calls)[number]) => {
      const post = (direction: string) => async (input: CreateAdjustmentInput) => {
        observed.push({ direction, input });
        return { transactionId: '00000000-0000-4000-8000-000000000906', created: true };
      };
      return {
        adjustments: { credit: post('credit'), debit: post('debit') },
      } as unknown as ApplicationServices;
    };
    const makeOptions = (observed: unknown[]): LedgerAdapterOptions<object> => ({
      authorizeAdjustment:
        override === false
          ? false
          : (((context) => {
              const { request, ...input } = context;
              observed.push(input);
              if (override) return override(context);
              const principal = principals.get(request);
              if (!principal) throw new UnauthorizedError('Bearer token is required');
              if (!principal.allowedDirections.includes(context.direction)) {
                throw new ForbiddenError('Adjustment is not permitted');
              }
              // The host authenticates the service and authorizes delegation before resolving this actor.
              return { actorId: principal.effectiveActorId };
            }) satisfies AdjustmentAuthorizationHook<object>),
    });
    const server = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    server.decorateRequest('tenantId');
    server.decorateRequest('apiKeyId');
    server.decorateRequest('apiKeyRole');
    server.addHook('onRequest', async (request) => {
      await authenticate(request);
    });
    registerFastifyLedgerAdapter(server, makeServices(calls[0]), makeOptions(policyCalls[0]));
    const app = express();
    app.use(express.json());
    app.use(async (request, _response, next) => {
      await authenticate(request);
      next();
    });
    registerExpressLedgerAdapter(app, makeServices(calls[1]), makeOptions(policyCalls[1]));

    const request = async (path: string, body: unknown) => {
      const fastify = await server.inject({ method: 'POST', url: path, payload: body as object });
      const req = httpMocks.createRequest({ method: 'POST', url: path, body: body as object });
      const res = httpMocks.createResponse({
        eventEmitter: (await import('node:events')).EventEmitter,
      });
      await new Promise<void>((resolve, reject) => {
        res.on('finish', resolve);
        app(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
      });
      const actual = { status: fastify.statusCode, json: fastify.json() };
      expect({ status: res.statusCode, json: res._getJSONData() }).toEqual(actual);
      expect(calls[1]).toEqual(calls[0]);
      expect(policyCalls[1]).toEqual(policyCalls[0]);
      return actual;
    };
    return { request, calls, policyCalls, close: () => server.close() };
  };

  for (const direction of ['credit', 'debit'] as const) {
    const path = `/v1/adjustments/${direction}`;
    it.each([
      ['missing authentication', undefined, adjustmentPayload, 401, 'UNAUTHORIZED'],
      [
        'missing tenant',
        { ...servicePrincipal, tenantId: '' },
        adjustmentPayload,
        401,
        'UNAUTHORIZED',
      ],
      [
        'SERVICE without permission',
        { ...servicePrincipal, allowedDirections: [] },
        adjustmentPayload,
        403,
        'FORBIDDEN',
      ],
      [
        'ADMIN without permission',
        { ...servicePrincipal, apiKeyRole: ApiKeyRole.ADMIN, allowedDirections: [] },
        adjustmentPayload,
        403,
        'FORBIDDEN',
      ],
      [
        'opposite direction only',
        { ...servicePrincipal, allowedDirections: [direction === 'credit' ? 'debit' : 'credit'] },
        adjustmentPayload,
        403,
        'FORBIDDEN',
      ],
      ['spoofed actor', servicePrincipal, adjustmentPayload, 403, 'FORBIDDEN'],
      [
        'unauthorized delegation',
        servicePrincipal,
        { ...adjustmentPayload, actor_id: 'opaque:on-behalf-of:42' },
        403,
        'FORBIDDEN',
      ],
      [
        'no trusted actor',
        { ...servicePrincipal, effectiveActorId: '' },
        adjustmentPayload,
        403,
        'FORBIDDEN',
      ],
      [
        'malformed actor',
        servicePrincipal,
        { ...adjustmentPayload, actor_id: ' ' },
        400,
        'INVALID_INPUT',
      ],
      [
        'body tenant override',
        servicePrincipal,
        {
          ...adjustmentPayload,
          actor_id: servicePrincipal.effectiveActorId,
          tenant_id: 'other-tenant',
        },
        400,
        'INVALID_INPUT',
      ],
    ] as const)(`${direction}: rejects %s before invoking the service`, async (_name, principal, payload, status, error) => {
      const hosts = createHosts(async () => principal);
      try {
        expect(await hosts.request(path, payload)).toMatchObject({ status, json: { error } });
        expect(hosts.calls).toEqual([[], []]);
        if (status === 400 || status === 401) expect(hosts.policyCalls).toEqual([[], []]);
      } finally {
        await hosts.close();
      }
    });

    it.each([
      'service:billing',
      'opaque:on-behalf-of:42',
    ])(`${direction}: accepts authorized actor %s`, async (actorId) => {
      // The host resolver explicitly permits delegation before returning an effective actor.
      const principal = {
        ...servicePrincipal,
        tenantId: '22222222-2222-4222-8222-222222222222',
        effectiveActorId: actorId,
      };
      const hosts = createHosts(async () => principal);
      const attributes = { ticket: 'T-1', asserted_user: 'unverified-caller-metadata' };
      try {
        expect(
          await hosts.request(path, { ...adjustmentPayload, actor_id: actorId, attributes }),
        ).toMatchObject({ status: 201 });
        expect(hosts.policyCalls[0]).toEqual([
          {
            direction,
            tenantId: principal.tenantId,
            apiKeyId: principal.apiKeyId,
            apiKeyRole: principal.apiKeyRole,
            body: { ...adjustmentPayload, actor_id: actorId, attributes },
          },
        ]);
        expect(hosts.calls[0]).toEqual([
          {
            direction,
            input: {
              tenantId: principal.tenantId,
              ledgerId: adjustmentPayload.ledger_id,
              accountId: adjustmentPayload.account_id,
              offsetAccountId: adjustmentPayload.offset_account_id,
              reference: adjustmentPayload.reference,
              amountMinor: 25n,
              description: adjustmentPayload.description,
              reasonCode: adjustmentPayload.reason_code,
              actorId,
              attributes,
            },
          },
        ]);
      } finally {
        await hosts.close();
      }
    });

    it(`${direction}: reauthorizes retries after permission revocation`, async () => {
      let principal: Principal = servicePrincipal;
      const hosts = createHosts(async () => principal);
      const payload = { ...adjustmentPayload, actor_id: principal.effectiveActorId };
      try {
        expect(await hosts.request(path, payload)).toMatchObject({ status: 201 });
        principal = { ...principal, allowedDirections: [] };
        expect(await hosts.request(path, payload)).toMatchObject({
          status: 403,
          json: { error: 'FORBIDDEN' },
        });
        expect(hosts.calls[0]).toHaveLength(1);
      } finally {
        await hosts.close();
      }
    });
  }

  it('requires an explicit callback or false when registering', async () => {
    const server = Fastify();
    try {
      const expected = 'authorizeAdjustment must be a function or explicitly false';
      expect(() => registerFastifyLedgerAdapter(server, {} as ApplicationServices)).toThrow(
        expected,
      );
      expect(() => registerExpressLedgerAdapter(express(), {} as ApplicationServices)).toThrow(
        expected,
      );
      expect(() =>
        registerFastifyLedgerAdapter(
          server,
          {} as ApplicationServices,
          {} as LedgerAdapterOptions<object>,
        ),
      ).toThrow(expected);
      expect(() =>
        registerExpressLedgerAdapter(
          express(),
          {} as ApplicationServices,
          {} as LedgerAdapterOptions<object>,
        ),
      ).toThrow(expected);
      expect(server.hasRoute({ method: 'POST', url: paths[0] })).toBe(false);
    } finally {
      await server.close();
    }
  });

  it.each([
    undefined,
    null,
    'invalid',
    true,
    0,
    '',
  ])('rejects registration with invalid callback %j', async (callback) => {
    const server = Fastify();
    try {
      const expected = 'authorizeAdjustment must be a function or explicitly false';
      expect(() =>
        registerFastifyLedgerAdapter(server, {} as ApplicationServices, {
          authorizeAdjustment: callback as unknown as AdjustmentAuthorizationHook<object>,
        }),
      ).toThrow(expected);
      expect(() =>
        registerExpressLedgerAdapter(express(), {} as ApplicationServices, {
          authorizeAdjustment: callback as unknown as AdjustmentAuthorizationHook<object>,
        }),
      ).toThrow(expected);
      expect(server.hasRoute({ method: 'POST', url: paths[0] })).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('isolates posted fields and nested audit metadata from callback and raw request mutations', async () => {
    const hosts = createHosts(
      async () => servicePrincipal,
      ({ body, request }) => {
        type MutableBody = {
          actor_id: string;
          amount_minor: string;
          attributes: { nested: { label: string }; values: string[] };
        };
        // Exercise untyped JavaScript hosts as well as callers circumventing readonly types.
        const copy = body as unknown as MutableBody;
        copy.actor_id = 'spoofed-copy';
        copy.amount_minor = '999';
        copy.attributes.nested.label = 'changed-copy';
        copy.attributes.values.push('changed-copy');
        const raw = (request as { body: MutableBody }).body;
        raw.actor_id = 'spoofed-request';
        raw.amount_minor = '888';
        raw.attributes.nested.label = 'changed-request';
        raw.attributes.values.push('changed-request');
        return { actorId: servicePrincipal.effectiveActorId };
      },
    );
    try {
      expect(
        await hosts.request(paths[0], {
          ...adjustmentPayload,
          actor_id: servicePrincipal.effectiveActorId,
          attributes: { nested: { label: 'original' }, values: ['original'] },
        }),
      ).toMatchObject({ status: 201 });
      expect(hosts.calls[0][0]?.input).toMatchObject({
        actorId: servicePrincipal.effectiveActorId,
        amountMinor: 25n,
        attributes: { nested: { label: 'original' }, values: ['original'] },
      });
    } finally {
      await hosts.close();
    }
  });

  it('awaits asynchronous authorization before invoking a service', async () => {
    const hosts = createHosts(
      async () => servicePrincipal,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new ForbiddenError('Delegation is not permitted');
      },
    );
    try {
      expect(await hosts.request(paths[0], adjustmentPayload)).toMatchObject({
        status: 403,
        json: { error: 'FORBIDDEN' },
      });
      expect(hosts.calls).toEqual([[], []]);
    } finally {
      await hosts.close();
    }
  });

  it.each([
    undefined,
    null,
    {},
    { actorId: '' },
  ])('denies malformed callback result %j', async (result) => {
    const hosts = createHosts(
      async () => servicePrincipal,
      () => result as { actorId: string },
    );
    try {
      expect(await hosts.request(paths[0], adjustmentPayload)).toMatchObject({
        status: 403,
        json: { error: 'FORBIDDEN' },
      });
      expect(hosts.calls).toEqual([[], []]);
    } finally {
      await hosts.close();
    }
  });

  it('skips authorization only with an explicit false callback', async () => {
    const hosts = createHosts(async () => servicePrincipal, false);
    try {
      expect(await hosts.request(paths[0], adjustmentPayload)).toMatchObject({ status: 201 });
      expect(hosts.calls[0][0]?.input.actorId).toBe(adjustmentPayload.actor_id);
      expect(hosts.policyCalls).toEqual([[], []]);
    } finally {
      await hosts.close();
    }
  });

  it('redacts unexpected host policy failures', async () => {
    const hosts = createHosts(
      async () => servicePrincipal,
      () => {
        throw new Error('private authorization backend detail');
      },
    );
    try {
      expect(await hosts.request(paths[0], adjustmentPayload)).toEqual({
        status: 500,
        json: { error: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
      expect(hosts.calls).toEqual([[], []]);
    } finally {
      await hosts.close();
    }
  });
});

describe('asset route parity', () => {
  const assetId = '00000000-0000-4000-8000-000000000903';
  const otherTenantId = '22222222-2222-4222-8222-222222222222';
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const expectedAsset = {
    id: assetId,
    tenant_id: tenantId,
    code: 'USD',
    scale: 2,
    created_at: createdAt.toISOString(),
  };
  const listCalls: Parameters<AssetRepository['list']>[0][] = [];
  const fastifyAssets: Asset[] = [];
  const expressAssets: Asset[] = [];

  beforeEach(() => {
    fastifyAssets.length = 0;
    expressAssets.length = 0;
    listCalls.length = 0;
  });

  const makeServices = (assets: Asset[]) => {
    return {
      assets: new AssetService({
        async create(input) {
          if (input.code === 'FAIL') throw new Error('private database detail');
          if (
            assets.some((asset) => asset.tenantId === input.tenantId && asset.code === input.code)
          ) {
            throw new AssetCodeConflictError(input.code);
          }
          const asset = { ...input, id: assetId, createdAt };
          assets.push(asset);
          return asset;
        },
        async findById(tenantId, assetId) {
          return (
            assets.find((asset) => asset.tenantId === tenantId && asset.id === assetId) ?? null
          );
        },
        async list(query) {
          listCalls.push(query);
          const data = assets.filter((asset) => asset.tenantId === query.tenantId);
          return { data, nextCursor: data.length ? 'opaque-cursor' : null };
        },
      }),
    } as unknown as ApplicationServices;
  };

  type Principal = 'admin' | 'service' | 'other-tenant';
  const authenticate = (request: object, principal: string | undefined) => {
    if (!principal) return;
    Object.assign(request, {
      tenantId: principal === 'other-tenant' ? otherTenantId : tenantId,
      apiKeyId: 'trusted-test-key',
      apiKeyRole: principal === 'admin' ? ApiKeyRole.ADMIN : ApiKeyRole.SERVICE,
    });
  };

  const server = Fastify();
  server.addHook('onRequest', async (request) => {
    authenticate(request, request.headers['x-test-principal']?.toString());
  });
  registerFastifyLedgerAdapter(server, makeServices(fastifyAssets), { authorizeAdjustment: false });

  const app = express();
  app.use((request, _response, next) => {
    authenticate(request, request.header('x-test-principal'));
    next();
  });
  registerExpressLedgerAdapter(app, makeServices(expressAssets), { authorizeAdjustment: false });

  afterAll(async () => {
    await server.close();
  });

  const request = async (
    method: 'GET' | 'POST',
    url: string,
    principal?: Principal,
    payload?: UnknownRecord,
  ): Promise<RequestResult> => {
    const headers = principal ? { 'x-test-principal': principal } : {};
    const fastify = await server.inject({ method, url, headers, payload });
    const req = httpMocks.createRequest({ method, url, headers, body: payload });
    const res = httpMocks.createResponse({ eventEmitter: EventEmitter });
    await new Promise<void>((resolve, reject) => {
      res.on('finish', resolve);
      app(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
    });
    const actual = { status: fastify.statusCode, json: fastify.json() };
    expect({ status: res.statusCode, json: res._getJSONData() }).toEqual(actual);
    return actual;
  };

  it('provisions as admin and exposes asset scales and typed pagination to tenant service keys', async () => {
    expect(await request('POST', '/v1/assets', 'admin', { code: ' usd ', scale: 2 })).toEqual({
      status: 201,
      json: expectedAsset,
    });
    expect(await request('GET', `/v1/assets/${assetId}`, 'service')).toEqual({
      status: 200,
      json: expectedAsset,
    });

    const where = encodeURIComponent(
      JSON.stringify({
        code: { eq: 'USD' },
        scale: { gte: 2 },
        created_at: { lte: createdAt.toISOString() },
      }),
    );
    expect(await request('GET', `/v1/assets?limit=1&where=${where}`, 'service')).toEqual({
      status: 200,
      json: { data: [expectedAsset], next_cursor: 'opaque-cursor' },
    });
    const expectedQuery = {
      tenantId,
      limit: 1,
      cursor: undefined,
      where: { code: { eq: 'USD' }, scale: { gte: 2 }, createdAt: { lte: createdAt } },
    };
    expect(listCalls.slice(-2)).toEqual([expectedQuery, expectedQuery]);
    await request('GET', `/v1/assets?cursor=opaque-cursor&where=${where}`, 'service');
    const nextQuery = { ...expectedQuery, limit: 50, cursor: 'opaque-cursor' };
    expect(listCalls.slice(-2)).toEqual([nextQuery, nextQuery]);
  });

  it('restricts access by trusted principal and maps duplicates and failures safely', async () => {
    const payload = { code: 'EUR', scale: 2 };
    expect((await request('POST', '/v1/assets', undefined, payload)).status).toBe(401);
    expect((await request('POST', '/v1/assets', 'service', payload)).status).toBe(403);
    expect((await request('GET', '/v1/assets')).status).toBe(401);
    expect((await request('GET', `/v1/assets/${assetId}`)).status).toBe(401);
    expect((await request('POST', '/v1/assets', 'admin', payload)).status).toBe(201);
    expect((await request('GET', `/v1/assets/${assetId}`, 'other-tenant')).status).toBe(404);
    expect(await request('GET', '/v1/assets', 'other-tenant')).toEqual({
      status: 200,
      json: { data: [], next_cursor: null },
    });
    expect(await request('POST', '/v1/assets', 'admin', payload)).toMatchObject({
      status: 409,
      json: { error: 'ASSET_CODE_CONFLICT' },
    });
    expect(await request('POST', '/v1/assets', 'admin', { code: 'FAIL', scale: 2 })).toEqual({
      status: 500,
      json: { error: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('rejects malformed body, UUID, limit, cursor and filter inputs', async () => {
    for (const payload of [
      { code: 'USD' },
      { code: 'USD', scale: -1 },
      { code: 'USD', scale: 19 },
      { code: 'USD', scale: 2.5 },
      { code: 'USD', scale: '2' },
      { code: 'USD', scale: true },
      { code: 'USD', scale: null },
      { code: ['USD'], scale: 2 },
      { code: 'USD', scale: 2, tenant_id: otherTenantId },
      { code: '$', scale: 2 },
    ]) {
      expect((await request('POST', '/v1/assets', 'admin', payload)).status).toBe(400);
    }
    for (const path of [
      '/v1/assets/invalid',
      '/v1/assets?limit=0',
      '/v1/assets?limit=201',
      '/v1/assets?limit=1&limit=2',
      '/v1/assets?cursor=',
      '/v1/assets?cursor=a&cursor=b',
      `/v1/assets?tenant_id=${otherTenantId}`,
      `/v1/assets?where=${encodeURIComponent('{"scale":{"eq":"2"}}')}`,
      `/v1/assets?where=${encodeURIComponent(JSON.stringify({ code: { eq: 'EU\0R' } }))}`,
      `/v1/assets?where=${encodeURIComponent(JSON.stringify({ code: { in: ['EU\0R'] } }))}`,
      `/v1/assets?where=${encodeURIComponent('{"tenant_id":{"eq":"other"}}')}`,
    ]) {
      expect((await request('GET', path, 'service')).status).toBe(400);
    }
  });
});
