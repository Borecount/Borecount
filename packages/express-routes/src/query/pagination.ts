import type { UnknownRecord } from '@borecount/core/base';
import { parseCursorQuery, parseLimitQuery } from '@borecount/http/query/pagination';

export type ResolvedPaginationQuery = {
  limit: number;
  cursor?: string;
};

export const parsePaginationQuery = (query: UnknownRecord): ResolvedPaginationQuery | null => {
  const limit = parseLimitQuery(query.limit);
  const cursor = parseCursorQuery(query.cursor);
  if (limit === null || (query.cursor !== undefined && cursor === null)) {
    return null;
  }
  return {
    limit,
    cursor: cursor ?? undefined,
  };
};
