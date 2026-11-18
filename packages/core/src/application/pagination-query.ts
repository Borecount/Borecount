import { InvariantViolationError } from '../errors';
import { assertNonEmpty } from '../utils';
import type { BasePaginationQuery } from './types';

export const MAX_PAGE_LIMIT = 200;

export const validatePaginationQuery = (query: BasePaginationQuery): void => {
  assertNonEmpty(query.tenantId, 'tenantId is required');

  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_PAGE_LIMIT) {
    throw new InvariantViolationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }

  if (query.cursor !== undefined && query.cursor.trim().length === 0) {
    throw new InvariantViolationError('cursor must be a non-empty string');
  }
};
