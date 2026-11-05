import type { PaginatedResult } from '@borecount/core/application';
import type { UnknownRecord } from '@borecount/core/base';
import type { PaginationQuery } from '@borecount/http/contracts';
import { mergePaginationQuerySchema } from '@borecount/http/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { handleValidationError } from '../errors/validation-error-handler';
import { BaseEntityRoute } from './base-route';

export type PaginatedRequest<Query extends PaginationQuery = PaginationQuery> = FastifyRequest<{
  Querystring: Query;
}>;

export abstract class BasePaginatedRoute<
  Source,
  Target,
  Query extends PaginationQuery = PaginationQuery,
> extends BaseEntityRoute<Source, Target> {
  protected abstract readonly path: string;

  protected abstract list(request: PaginatedRequest<Query>): Promise<PaginatedResult<Source>>;

  protected querystringSchema(extra: UnknownRecord = {}) {
    return mergePaginationQuerySchema(extra);
  }

  protected abstract responseSchema(): UnknownRecord;

  public register(server: FastifyInstance): void {
    server.get<{ Querystring: Query }>(
      this.path,
      {
        errorHandler: handleValidationError,
        schema: {
          querystring: this.querystringSchema(),
          response: {
            200: this.responseSchema(),
          },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const page = await this.list(request);
          return reply.status(200).send({
            data: this.dtoList(page.data),
            next_cursor: page.nextCursor,
          });
        }),
    );
  }
}
