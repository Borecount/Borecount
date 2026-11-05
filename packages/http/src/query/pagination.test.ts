import { describe, expect, it } from 'bun:test';
import {
  MAX_FILTER_IN_VALUES,
  MAX_PAGE_LIMIT,
  validateListWhere,
  validatePaginationQuery,
} from '@borecount/core/application';
import { InvariantViolationError } from '@borecount/core/errors';
import { paginationQuerySchema } from '../contracts/pagination';
import { isUuid, parseUuidParam } from '../validation-utils';
import { parseWhere, whereFieldsToJsonSchema } from './list-filter';
import { parseLimitQuery, parseUuidQuery } from './pagination';

const fields = { id: { kind: 'uuid' } } as const;
const uuid = '00000000-0000-7000-8000-000000000001';

describe('shared UUID validation', () => {
  it('accepts UUID versions 1 through 8 consistently for paths, queries and filters', () => {
    for (let version = 1; version <= 8; version++) {
      const value = `00000000-0000-${version}000-8000-000000000001`;
      expect(isUuid(value)).toBe(true);
      expect(parseUuidParam(value, 'id')).toEqual({ id: value });
      expect(parseUuidQuery(value)).toBe(value);
      const filter = { id: { eq: value } };
      expect(parseWhere<typeof filter>(JSON.stringify(filter), fields)).toEqual(filter);
    }
  });

  it('rejects malformed UUIDs and non-string inputs consistently', () => {
    for (const value of [
      undefined,
      null,
      '',
      ' ',
      [uuid],
      { id: uuid },
      '00000000-0000-0000-8000-000000000001',
      '00000000-0000-9000-8000-000000000001',
      '00000000-0000-7000-0000-000000000001',
      'gggggggg-0000-7000-8000-000000000001',
    ]) {
      expect(isUuid(value)).toBe(false);
      expect(parseUuidParam(value, 'id')).toBeNull();
      expect(parseUuidQuery(value)).toBeNull();
      expect(parseWhere(JSON.stringify({ id: { eq: value } }), fields)).toBeNull();
    }
  });
});

describe('core and HTTP resource bounds', () => {
  it('uses the same pagination maximum in service validation, parsing and schemas', () => {
    expect(() =>
      validatePaginationQuery({ tenantId: 'tenant', limit: MAX_PAGE_LIMIT }),
    ).not.toThrow();
    expect(parseLimitQuery(String(MAX_PAGE_LIMIT))).toBe(MAX_PAGE_LIMIT);
    expect(paginationQuerySchema.properties.limit.maximum).toBe(MAX_PAGE_LIMIT);
    expect(() =>
      validatePaginationQuery({ tenantId: 'tenant', limit: MAX_PAGE_LIMIT + 1 }),
    ).toThrow(InvariantViolationError);
    expect(parseLimitQuery(String(MAX_PAGE_LIMIT + 1))).toBeNull();
  });

  it('uses the same in-filter maximum in core validation, HTTP parsing and schemas', () => {
    const allowed = { id: { in: Array.from({ length: MAX_FILTER_IN_VALUES }, () => uuid) } };
    const rejected = { id: { in: [...allowed.id.in, uuid] } };
    expect(() => validateListWhere([], allowed)).not.toThrow();
    expect(parseWhere<typeof allowed>(JSON.stringify(allowed), fields)).toEqual(allowed);
    expect(() => validateListWhere([], rejected)).toThrow(InvariantViolationError);
    expect(parseWhere(JSON.stringify(rejected), fields)).toBeNull();
    expect(whereFieldsToJsonSchema(fields)).toMatchObject({
      properties: { id: { properties: { in: { maxItems: MAX_FILTER_IN_VALUES } } } },
    });
  });
});
