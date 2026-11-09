import { ApiKeyRole, type AssetService } from '@borecount/core/application';
import { ForbiddenError, UnauthorizedError } from '@borecount/core/errors';
import {
  type AssetByIdParams,
  assetByIdParamsSchema,
  assetResponseSchema,
  assetsListResponseSchema,
  type CreateAssetRequest,
  createAssetBodySchema,
  parseAssetListQuery,
} from '@borecount/http/contracts';
import { toAssetResponse } from '@borecount/http/mappers';
import { isRecord } from '@borecount/http/validation-utils';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendInvalidInput } from '../errors/send-invalid-input';
import { handleValidationError } from '../errors/validation-error-handler';
import { BaseRoute } from '../routing/base-route';

const requireContext = ({ tenantId, apiKeyId, apiKeyRole }: FastifyRequest) => {
  if (!tenantId || !apiKeyId || !apiKeyRole) {
    throw new UnauthorizedError('Bearer token is required');
  }
  return { tenantId, apiKeyRole };
};

export class AssetsRoutes extends BaseRoute {
  public constructor(private readonly assets: AssetService) {
    super();
  }

  public register(server: FastifyInstance): void {
    server.post<{ Body: CreateAssetRequest }>(
      '/v1/assets',
      {
        errorHandler: handleValidationError,
        schema: {
          body: createAssetBodySchema,
          response: { 201: assetResponseSchema },
        },
        preValidation: async (request, reply) => {
          // Reject input that Fastify's default validator could coerce or strip.
          const body: unknown = request.body;
          if (
            !isRecord(body) ||
            typeof body.code !== 'string' ||
            typeof body.scale !== 'number' ||
            Object.keys(body).some((key) => !Object.hasOwn(createAssetBodySchema.properties, key))
          ) {
            return sendInvalidInput(reply, 'Invalid request body');
          }
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const { tenantId, apiKeyRole } = requireContext(request);
          if (apiKeyRole !== ApiKeyRole.ADMIN) {
            throw new ForbiddenError('Admin API key is required');
          }
          const { code, scale } = request.body;
          const asset = await this.assets.create({ tenantId, code, scale });
          return reply.status(201).send(toAssetResponse(asset));
        }),
    );

    server.get<{ Params: AssetByIdParams }>(
      '/v1/assets/:id',
      {
        errorHandler: handleValidationError,
        schema: {
          params: assetByIdParamsSchema,
          response: { 200: assetResponseSchema },
        },
      },
      async (request, reply) =>
        this.handle(reply, async () => {
          const { tenantId } = requireContext(request);
          const asset = await this.assets.getById(tenantId, request.params.id);
          return reply.status(200).send(toAssetResponse(asset));
        }),
    );

    server.get(
      '/v1/assets',
      { schema: { response: { 200: assetsListResponseSchema } } },
      async (request, reply) =>
        this.handle(reply, async () => {
          const query = parseAssetListQuery(request.raw.url ?? '');
          if (query === null) return sendInvalidInput(reply, 'Invalid querystring');
          const { tenantId } = requireContext(request);
          const page = await this.assets.list({ tenantId, ...query });
          return reply.status(200).send({
            data: page.data.map(toAssetResponse),
            next_cursor: page.nextCursor,
          });
        }),
    );
  }
}
