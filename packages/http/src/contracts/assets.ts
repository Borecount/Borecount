import type { assetListFilter, PaginationQuery } from '@borecount/core/application';
import { parseWhere, whereQueryProperty } from '../query/list-filter';
import { assetFilterFields } from '../query/list-filter-fields';
import { parseCursorQuery, parseLimitQuery } from '../query/pagination';
import type { InferSchema } from '../schema-types';
import { createPaginatedResponseSchema, mergePaginationQuerySchema } from './pagination';

const { minimum, maximum } = assetFilterFields.scale;
const assetScaleSchema = { type: 'integer', minimum, maximum } as const;

export const createAssetBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'scale'],
  properties: {
    code: { type: 'string' },
    scale: assetScaleSchema,
  },
} as const;

export const assetByIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export const listAssetsQuerySchema = mergePaginationQuerySchema({
  properties: { where: whereQueryProperty(assetFilterFields) },
});

export const assetResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenant_id', 'code', 'scale', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenant_id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    scale: assetScaleSchema,
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const assetsListResponseSchema = createPaginatedResponseSchema(assetResponseSchema);

export type CreateAssetRequest = InferSchema<typeof createAssetBodySchema>;
export type AssetByIdParams = InferSchema<typeof assetByIdParamsSchema>;
export type AssetResponse = InferSchema<typeof assetResponseSchema>;
export type ListAssetsQuery = InferSchema<typeof listAssetsQuerySchema>;

export const parseAssetListQuery = (
  url: string,
): Omit<PaginationQuery<typeof assetListFilter>, 'tenantId'> | null => {
  const params = new URL(url, 'http://localhost').searchParams;
  for (const key of params.keys()) {
    if (!Object.hasOwn(listAssetsQuerySchema.properties, key) || params.getAll(key).length > 1) {
      return null;
    }
  }

  const limit = parseLimitQuery(params.get('limit') ?? undefined);
  const cursor = parseCursorQuery(params.get('cursor'));
  const where = parseWhere<PaginationQuery<typeof assetListFilter>['where']>(
    params.get('where') ?? undefined,
    assetFilterFields,
  );
  if (limit === null || (params.has('cursor') && cursor === null) || where === null) {
    return null;
  }
  return { limit, cursor: cursor ?? undefined, where };
};
