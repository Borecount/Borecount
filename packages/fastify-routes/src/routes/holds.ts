import type {
  HoldService,
  holdCaptureListFilter,
  holdCreditAllocationListFilter,
  holdEntryListFilter,
  holdListFilter,
  WhereFor,
} from '@borecount/core/application';
import {
  holdCaptureFilterFields,
  holdCreditAllocationFilterFields,
  holdEntryFilterFields,
  holdSummaryFilterFields,
  invalidWhereError,
  readWhereParameter,
} from '@borecount/http';
import {
  type CommitHoldRequest,
  type CreateHoldRequest,
  commitHoldRequestSchema,
  commitHoldResponseSchema,
  createHoldRequestSchema,
  createHoldResponseSchema,
  type HoldIdParams,
  holdCapturesPageResponseSchema,
  holdCreditAllocationsPageResponseSchema,
  holdEntriesPageResponseSchema,
  holdIdParamsSchema,
  holdSummaryResponseSchema,
  holdsPageResponseSchema,
  listHoldCapturesQuerySchema,
  listHoldCreditAllocationsQuerySchema,
  listHoldEntriesQuerySchema,
  listHoldsQuerySchema,
  voidHoldResponseSchema,
} from '@borecount/http/contracts';
import {
  toHoldCaptureResponse,
  toHoldCreditAllocationResponse,
  toHoldEntryResponse,
  toHoldSummaryResponse,
  toPaginatedResponse,
} from '@borecount/http/mappers';
import { resolveLimit } from '@borecount/http/query/pagination';
import type { FastifyInstance } from 'fastify';
import { handleValidationError } from '../errors/validation-error-handler';
import { BaseRoute } from '../routing/base-route';

export class HoldsRoutes extends BaseRoute {
  public constructor(private readonly holds: HoldService) {
    super();
  }

  public register(server: FastifyInstance): void {
    this.registerReads(server);
    this.registerCreateHold(server);
    this.registerCommitHold(server);
    this.registerVoidHold(server);
  }

  private registerReads(server: FastifyInstance): void {
    server.get<{ Params: HoldIdParams }>(
      '/v1/holds/:id',
      {
        errorHandler: handleValidationError,
        schema: { params: holdIdParamsSchema, response: { 200: holdSummaryResponseSchema } },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const hold = await this.holds.getById(request.tenantId as string, request.params.id);
          return reply.status(200).send(toHoldSummaryResponse(hold));
        }),
    );

    server.get<{
      Params: HoldIdParams;
      Querystring: { limit?: number; cursor?: string; where?: string };
    }>(
      '/v1/holds',
      {
        errorHandler: handleValidationError,
        schema: { querystring: listHoldsQuerySchema, response: { 200: holdsPageResponseSchema } },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof holdListFilter>>(
            request.raw.url ?? '',
            holdSummaryFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const page = await this.holds.list({
            tenantId: request.tenantId as string,

            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply.status(200).send(toPaginatedResponse(page, toHoldSummaryResponse));
        }),
    );

    server.get<{
      Params: HoldIdParams;
      Querystring: { limit?: number; cursor?: string; where?: string };
    }>(
      '/v1/holds/:id/entries',
      {
        errorHandler: handleValidationError,
        schema: {
          params: holdIdParamsSchema,
          querystring: listHoldEntriesQuerySchema,
          response: { 200: holdEntriesPageResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof holdEntryListFilter>>(
            request.raw.url ?? '',
            holdEntryFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const page = await this.holds.listEntries({
            tenantId: request.tenantId as string,
            holdId: request.params.id,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply.status(200).send(toPaginatedResponse(page, toHoldEntryResponse));
        }),
    );

    server.get<{
      Params: HoldIdParams;
      Querystring: { limit?: number; cursor?: string; where?: string };
    }>(
      '/v1/holds/:id/captures',
      {
        errorHandler: handleValidationError,
        schema: {
          params: holdIdParamsSchema,
          querystring: listHoldCapturesQuerySchema,
          response: { 200: holdCapturesPageResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof holdCaptureListFilter>>(
            request.raw.url ?? '',
            holdCaptureFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const page = await this.holds.listCaptures({
            tenantId: request.tenantId as string,
            holdId: request.params.id,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply.status(200).send(toPaginatedResponse(page, toHoldCaptureResponse));
        }),
    );

    server.get<{
      Params: HoldIdParams;
      Querystring: { limit?: number; cursor?: string; where?: string };
    }>(
      '/v1/holds/:id/credit-allocations',
      {
        errorHandler: handleValidationError,
        schema: {
          params: holdIdParamsSchema,
          querystring: listHoldCreditAllocationsQuerySchema,
          response: { 200: holdCreditAllocationsPageResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof holdCreditAllocationListFilter>>(
            request.raw.url ?? '',
            holdCreditAllocationFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const page = await this.holds.listCreditAllocations({
            tenantId: request.tenantId as string,
            holdId: request.params.id,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply.status(200).send(toPaginatedResponse(page, toHoldCreditAllocationResponse));
        }),
    );
  }

  private registerCreateHold(server: FastifyInstance): void {
    server.post<{ Body: CreateHoldRequest }>(
      '/v1/holds',
      {
        errorHandler: handleValidationError,
        schema: {
          body: createHoldRequestSchema,
          response: {
            200: createHoldResponseSchema,
            201: createHoldResponseSchema,
          },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const result = await this.holds.create({
            tenantId: request.tenantId as string,
            ledgerId: request.body.ledger_id,
            reference: request.body.reference,
            currency: request.body.currency,
            description: request.body.description,
            entries: request.body.entries.map((entry) => ({
              accountId: entry.account_id,
              signedAmountMinor: BigInt(entry.signed_amount_minor),
              currency: entry.currency,
            })),
          });

          return reply.status(result.created ? 201 : 200).send({
            hold_id: result.holdId,
            created: result.created,
            state: result.state,
            remaining_amount_minor: result.remainingAmountMinor.toString(),
          });
        }),
    );
  }

  private registerCommitHold(server: FastifyInstance): void {
    server.post<{ Params: HoldIdParams; Body: CommitHoldRequest }>(
      '/v1/holds/:id/commit',
      {
        errorHandler: handleValidationError,
        schema: {
          params: holdIdParamsSchema,
          body: commitHoldRequestSchema,
          response: {
            200: commitHoldResponseSchema,
            201: commitHoldResponseSchema,
          },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const result = await this.holds.commit({
            tenantId: request.tenantId as string,
            holdId: request.params.id,
            reference: request.body.reference,
            amountMinor:
              request.body.amount_minor === undefined
                ? undefined
                : BigInt(request.body.amount_minor),
          });
          return reply.status(result.created ? 201 : 200).send({
            hold_id: result.holdId,
            transaction_id: result.transactionId,
            created: result.created,
            state: result.state,
            remaining_amount_minor: result.remainingAmountMinor.toString(),
          });
        }),
    );
  }

  private registerVoidHold(server: FastifyInstance): void {
    server.post<{ Params: HoldIdParams }>(
      '/v1/holds/:id/void',
      {
        errorHandler: handleValidationError,
        schema: {
          params: holdIdParamsSchema,
          response: { 200: voidHoldResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const result = await this.holds.void({
            tenantId: request.tenantId as string,
            holdId: request.params.id,
          });
          return reply.status(200).send({
            hold_id: result.holdId,
            state: result.state,
            voided: result.voided,
            remaining_amount_minor: result.remainingAmountMinor.toString(),
          });
        }),
    );
  }
}
