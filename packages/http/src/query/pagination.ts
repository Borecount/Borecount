import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../contracts/pagination';
import { isUuid } from '../validation-utils';

export const resolveLimit = (value: number | undefined): number => value ?? DEFAULT_PAGE_LIMIT;

export const parseLimitQuery = (value: unknown): number | null => {
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_PAGE_LIMIT) {
    return null;
  }
  return numeric;
};

export const parseCursorQuery = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
};

export const parseUuidQuery = (value: unknown): string | null => (isUuid(value) ? value : null);
