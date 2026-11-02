import { mergePaginationQuerySchema } from '@borecount/http/contracts';
import { resolveLimit } from '@borecount/http/query/pagination';

export const createPaginationQuerySchema = mergePaginationQuerySchema;
export const resolvePaginationLimit = resolveLimit;
