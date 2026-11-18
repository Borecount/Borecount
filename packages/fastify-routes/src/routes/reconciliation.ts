import type {
  ReconciliationService,
  reconResultListFilter,
  reconRuleListFilter,
  reconRunListFilter,
  reconUploadListFilter,
  WhereFor,
} from '@borecount/core/application';
import {
  invalidWhereError,
  readWhereParameter,
  reconResultListFilterFields,
  reconRuleFilterFields,
  reconRunListFilterFields,
  reconUploadListFilterFields,
} from '@borecount/http';
import {
  type CreateReconRuleRequest,
  createReconRuleRequestSchema,
  type IngestReconRecordsRequest,
  ingestReconRecordsRequestSchema,
  listReconRulesQuerySchema,
  listReconRunsQuerySchema,
  listReconUploadsQuerySchema,
  type ReconRunByIdParams,
  type ReconUploadByIdParams,
  type RunReconRequest,
  reconciliationRunByIdParamsSchema,
  reconciliationUploadByIdParamsSchema,
  reconRecordsListQuerySchema,
  reconRecordsListResponseSchema,
  reconResultsListQuerySchema,
  reconResultsListResponseSchema,
  reconRuleResponseSchema,
  reconRulesListResponseSchema,
  reconRunResponseSchema,
  reconRunsListResponseSchema,
  reconUploadResponseSchema,
  reconUploadsListResponseSchema,
  runReconRequestSchema,
} from '@borecount/http/contracts';
import {
  toReconRecordResponse,
  toReconResultResponse,
  toReconRuleResponse,
  toReconRunResponse,
  toReconRunSummaryResponse,
  toReconUploadResponse,
} from '@borecount/http/mappers';
import { resolveLimit } from '@borecount/http/query/pagination';
import type { FastifyInstance } from 'fastify';
import { handleValidationError } from '../errors/validation-error-handler';
import { BaseRoute } from '../routing/base-route';

export class ReconRoutes extends BaseRoute {
  public constructor(private readonly reconciliation: ReconciliationService) {
    super();
  }

  public register(server: FastifyInstance): void {
    this.registerCreateMatchingRule(server);
    this.registerListMatchingRules(server);
    this.registerListUploads(server);
    this.registerGetUpload(server);
    this.registerListUploadRecords(server);
    this.registerListRuns(server);
    this.registerIngestExternalRecords(server);
    this.registerRunReconciliation(server);
    this.registerGetReconciliationRun(server);
    this.registerListReconciliationResults(server);
  }

  private registerListUploads(server: FastifyInstance): void {
    server.get<{ Querystring: { where?: string; limit?: number; cursor?: string } }>(
      '/v1/reconciliation/uploads',
      {
        errorHandler: handleValidationError,
        schema: {
          querystring: listReconUploadsQuerySchema,
          response: { 200: reconUploadsListResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof reconUploadListFilter>>(
            request.raw.url ?? '',
            reconUploadListFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const page = await this.reconciliation.listUploads({
            tenantId: request.tenantId as string,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply
            .status(200)
            .send({ data: page.data.map(toReconUploadResponse), next_cursor: page.nextCursor });
        }),
    );
  }

  private registerGetUpload(server: FastifyInstance): void {
    server.get<{ Params: ReconUploadByIdParams }>(
      '/v1/reconciliation/uploads/:id',
      {
        errorHandler: handleValidationError,
        schema: {
          params: reconciliationUploadByIdParamsSchema,
          response: { 200: reconUploadResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const upload = await this.reconciliation.getUpload(
            request.tenantId as string,
            request.params.id,
          );
          return reply.status(200).send(toReconUploadResponse(upload));
        }),
    );
  }

  private registerListUploadRecords(server: FastifyInstance): void {
    server.get<{
      Params: ReconUploadByIdParams;
      Querystring: { limit?: number; cursor?: string };
    }>(
      '/v1/reconciliation/uploads/:id/records',
      {
        errorHandler: handleValidationError,
        schema: {
          params: reconciliationUploadByIdParamsSchema,
          querystring: reconRecordsListQuerySchema,
          response: { 200: reconRecordsListResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const page = await this.reconciliation.listRecords({
            tenantId: request.tenantId as string,
            uploadId: request.params.id,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
          });
          return reply
            .status(200)
            .send({ data: page.data.map(toReconRecordResponse), next_cursor: page.nextCursor });
        }),
    );
  }

  private registerListRuns(server: FastifyInstance): void {
    server.get<{ Querystring: { where?: string; limit?: number; cursor?: string } }>(
      '/v1/reconciliation/runs',
      {
        errorHandler: handleValidationError,
        schema: {
          querystring: listReconRunsQuerySchema,
          response: { 200: reconRunsListResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof reconRunListFilter>>(
            request.raw.url ?? '',
            reconRunListFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const page = await this.reconciliation.listRuns({
            tenantId: request.tenantId as string,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply
            .status(200)
            .send({ data: page.data.map(toReconRunSummaryResponse), next_cursor: page.nextCursor });
        }),
    );
  }

  private registerCreateMatchingRule(server: FastifyInstance): void {
    server.post<{ Body: CreateReconRuleRequest }>(
      '/v1/reconciliation/matching-rules',
      {
        errorHandler: handleValidationError,
        schema: {
          body: createReconRuleRequestSchema,
          response: { 201: reconRuleResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const rule = await this.reconciliation.createRule({
            tenantId: request.tenantId as string,
            name: request.body.name,
            description: request.body.description,
            criteria: request.body.criteria.map((criterion) => ({
              field: criterion.field,
              operator: criterion.operator,
              amountToleranceMinor:
                criterion.amount_tolerance_minor === undefined
                  ? undefined
                  : BigInt(criterion.amount_tolerance_minor),
              dateToleranceSeconds: criterion.date_tolerance_seconds,
            })),
          });

          return reply.status(201).send(toReconRuleResponse(rule));
        }),
    );
  }

  private registerListMatchingRules(server: FastifyInstance): void {
    server.get<{ Querystring: { where?: string; limit?: number; cursor?: string } }>(
      '/v1/reconciliation/matching-rules',
      {
        errorHandler: handleValidationError,
        schema: {
          querystring: listReconRulesQuerySchema,
          response: { 200: reconRulesListResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof reconRuleListFilter>>(
            request.raw.url ?? '',
            reconRuleFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const rules = await this.reconciliation.listRules({
            tenantId: request.tenantId as string,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply.status(200).send({
            data: rules.data.map(toReconRuleResponse),
            next_cursor: rules.nextCursor,
          });
        }),
    );
  }

  private registerListReconciliationResults(server: FastifyInstance): void {
    server.get<{
      Params: ReconRunByIdParams;
      Querystring: { where?: string; limit?: number; cursor?: string };
    }>(
      '/v1/reconciliation/runs/:id/results',
      {
        errorHandler: handleValidationError,
        schema: {
          params: reconciliationRunByIdParamsSchema,
          querystring: reconResultsListQuerySchema,
          response: { 200: reconResultsListResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const where = readWhereParameter<WhereFor<typeof reconResultListFilter>>(
            request.raw.url ?? '',
            reconResultListFilterFields,
          );
          if (where === null) throw invalidWhereError();
          const result = await this.reconciliation.listResults({
            tenantId: request.tenantId as string,
            runId: request.params.id,
            limit: resolveLimit(request.query.limit),
            cursor: request.query.cursor,
            where,
          });
          return reply
            .status(200)
            .send({ data: result.data.map(toReconResultResponse), next_cursor: result.nextCursor });
        }),
    );
  }

  private registerIngestExternalRecords(server: FastifyInstance): void {
    server.post<{ Body: IngestReconRecordsRequest }>(
      '/v1/reconciliation/external-records',
      {
        errorHandler: handleValidationError,
        schema: {
          body: ingestReconRecordsRequestSchema,
          response: { 201: reconUploadResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const upload = await this.reconciliation.ingest({
            tenantId: request.tenantId as string,
            source: request.body.source,
            records: request.body.records.map((record) => ({
              externalId: record.id,
              amountMinor: BigInt(record.amount_minor),
              currency: record.currency,
              reference: record.reference,
              description: record.description ?? null,
              occurredAt: new Date(record.date),
              raw: record.raw ?? null,
            })),
          });

          return reply.status(201).send(toReconUploadResponse(upload));
        }),
    );
  }

  private registerRunReconciliation(server: FastifyInstance): void {
    server.post<{ Body: RunReconRequest }>(
      '/v1/reconciliation/runs',
      {
        errorHandler: handleValidationError,
        schema: {
          body: runReconRequestSchema,
          response: {
            200: reconRunResponseSchema,
            201: reconRunResponseSchema,
          },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const run = await this.reconciliation.run({
            tenantId: request.tenantId as string,
            ledgerId: request.body.ledger_id,
            uploadId: request.body.upload_id,
            strategy: request.body.strategy,
            matchingRuleIds: request.body.matching_rule_ids,
            dryRun: request.body.dry_run,
          });

          return reply.status(request.body.dry_run ? 200 : 201).send(toReconRunResponse(run));
        }),
    );
  }

  private registerGetReconciliationRun(server: FastifyInstance): void {
    server.get<{ Params: ReconRunByIdParams }>(
      '/v1/reconciliation/runs/:id',
      {
        errorHandler: handleValidationError,
        schema: {
          params: reconciliationRunByIdParamsSchema,
          response: { 200: reconRunResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const run = await this.reconciliation.getRun(
            request.tenantId as string,
            request.params.id,
          );

          return reply.status(200).send(toReconRunResponse(run));
        }),
    );
  }
}
