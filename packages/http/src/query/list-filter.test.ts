import { describe, expect, it } from 'bun:test';
import {
  MAX_WHERE_LENGTH,
  parseWhere,
  readWhereParameter,
  whereFieldsToJsonSchema,
} from './list-filter';
import {
  accountFilterFields,
  holdCaptureFilterFields,
  holdCreditAllocationFilterFields,
  holdEntryFilterFields,
  holdSummaryFilterFields,
  transactionFilterFields,
} from './list-filter-fields';

describe('typed list filter parsing', () => {
  it('parses every hold read filter map with precise typed values and aliases', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const instant = '2025-01-01T10:20:30.123000Z';
    expect(
      parseWhere<Record<string, unknown>>(
        JSON.stringify({
          id: { eq: uuid },
          ledger_id: { eq: uuid },
          reference: { eq: 'hold-ref' },
          currency: { eq: 'USD' },
          description: { eq: null },
          state: { eq: 'HELD' },
          original_amount_minor: { gt: '9007199254740993' },
          remaining_amount_minor: { gte: '0' },
          created_at: { gte: instant },
          applied_at: { eq: null },
          voided_at: { ne: null },
          account_id: { eq: uuid },
        }),
        holdSummaryFilterFields,
      ),
    ).toEqual({
      id: { eq: uuid },
      ledgerId: { eq: uuid },
      reference: { eq: 'hold-ref' },
      currency: { eq: 'USD' },
      description: { eq: null },
      state: { eq: 'HELD' },
      originalAmountMinor: { gt: 9007199254740993n },
      remainingAmountMinor: { gte: 0n },
      createdAt: { gte: { exactTimestamp: instant } },
      appliedAt: { eq: null },
      voidedAt: { ne: null },
      accountId: { eq: uuid },
    });
    expect(
      parseWhere<Record<string, unknown>>(
        JSON.stringify({
          id: { eq: uuid },
          account_id: { eq: uuid },
          signed_amount_minor: { lte: '-9007199254740993' },
          currency: { eq: 'USD' },
          created_at: { eq: instant },
        }),
        holdEntryFilterFields,
      ),
    ).toEqual({
      id: { eq: uuid },
      accountId: { eq: uuid },
      signedAmountMinor: { lte: -9007199254740993n },
      currency: { eq: 'USD' },
      createdAt: { eq: { exactTimestamp: instant } },
    });
    expect(
      parseWhere<Record<string, unknown>>(
        JSON.stringify({
          id: { eq: uuid },
          reference: { eq: 'capture-ref' },
          amount_minor: { gt: '3' },
          currency: { eq: 'USD' },
          created_at: { eq: instant },
        }),
        holdCaptureFilterFields,
      ),
    ).toEqual({
      id: { eq: uuid },
      reference: { eq: 'capture-ref' },
      amountMinor: { gt: 3n },
      currency: { eq: 'USD' },
      createdAt: { eq: { exactTimestamp: instant } },
    });
    expect(
      parseWhere<Record<string, unknown>>(
        JSON.stringify({
          id: { eq: uuid },
          hold_entry_id: { eq: uuid },
          account_id: { eq: uuid },
          grant_id: { eq: uuid },
          amount_minor: { eq: '9007199254740993' },
          created_at: { eq: instant },
        }),
        holdCreditAllocationFilterFields,
      ),
    ).toEqual({
      id: { eq: uuid },
      holdEntryId: { eq: uuid },
      accountId: { eq: uuid },
      grantId: { eq: uuid },
      amountMinor: { eq: 9007199254740993n },
      createdAt: { eq: { exactTimestamp: instant } },
    });
  });

  it('rejects forbidden, unknown, wrongly typed, null, and imprecise hold filters', () => {
    const forbidden = [
      ['tenant_id', { eq: '123e4567-e89b-12d3-a456-426614174000' }],
      ['state', { eq: 'PENDING' }],
      ['description', { contains: 'hold' }],
      ['id', { eq: 'not-a-uuid' }],
      ['created_at', { gte: '2025-01-01T10:20:30.1230011Z' }],
      ['account_id', { eq: null }],
    ] as const;
    for (const [field, filter] of forbidden) {
      expect(parseWhere(JSON.stringify({ [field]: filter }), holdSummaryFilterFields)).toBeNull();
    }
    expect(
      parseWhere('{"created_at":{"eq":"2025-01-01T00:00:00.0000001Z"}}', holdCaptureFilterFields),
    ).toBeNull();
    expect(parseWhere('{"amount_minor":{"eq":"1.5"}}', holdCaptureFilterFields)).toBeNull();
    expect(
      parseWhere(
        '{"hold_id":{"eq":"123e4567-e89b-12d3-a456-426614174000"}}',
        holdEntryFilterFields,
      ),
    ).toBeNull();
    expect(
      parseWhere(
        '{"hold_id":{"eq":"123e4567-e89b-12d3-a456-426614174000"}}',
        holdCreditAllocationFilterFields,
      ),
    ).toBeNull();
    expect(parseWhere('{"created_at":{"eq":null}}', holdCaptureFilterFields)).toBeNull();
  });

  it('parses typed values, aliases snake case and preserves bigint precision', () => {
    expect(
      parseWhere<Record<string, unknown>>(
        '{"balance_minor":{"gte":"9007199254740993"}}',
        accountFilterFields,
      ),
    ).toEqual({
      balanceMinor: { gte: 9007199254740993n },
    });
    expect(
      parseWhere<Record<string, unknown>>(
        '{"ledger_id":{"eq":"123e4567-e89b-12d3-a456-426614174000"}}',
        accountFilterFields,
      ),
    ).toEqual({
      ledgerId: { eq: '123e4567-e89b-12d3-a456-426614174000' },
    });
  });

  it('rejects malformed, unknown, nested, repeated and oversized filters', () => {
    for (const value of [
      '[]',
      '1',
      '{',
      '{"tenant_id":{"eq":"x"}}',
      '{"name":{}}',
      '{"name":{"contains":"x"}}',
    ]) {
      expect(parseWhere(value, accountFilterFields)).toBeNull();
    }
    expect(readWhereParameter('/?where=%7B%7D&where=%7B%7D', accountFilterFields)).toBeNull();
    expect(readWhereParameter('/?where%5Bname%5D%5Beq%5D=Cash', accountFilterFields)).toBeNull();
    expect(
      readWhereParameter('/?where=%7B%7D&where%5Bname%5D%5Beq%5D=Cash', accountFilterFields),
    ).toBeNull();
    expect(parseWhere(`{"name":{"eq":"${'x'.repeat(8200)}"}}`, accountFilterFields)).toBeNull();
  });

  it('accepts omitted and empty filters as no extra constraint', () => {
    expect(parseWhere(undefined, accountFilterFields)).toBeUndefined();
    expect(parseWhere('{}', accountFilterFields)).toBeUndefined();
    expect(parseWhere('', accountFilterFields)).toBeNull();
  });

  it('allows null only for eq/ne and validates timezone date-times', () => {
    expect(
      parseWhere<Record<string, unknown>>('{"code":{"eq":null}}', accountFilterFields),
    ).toEqual({ code: { eq: null } });
    expect(parseWhere('{"code":{"in":[null]}}', accountFilterFields)).toBeNull();
    expect(parseWhere('{"code":{"gt":null}}', accountFilterFields)).toBeNull();
    const timeFields = { created_at: { kind: 'date-time', ordered: true } } as const;
    expect(
      parseWhere('{"created_at":{"gte":"2024-02-29T10:20:30+02:00"}}', timeFields),
    ).not.toBeNull();
    expect(parseWhere('{"created_at":{"gte":"2025-02-29T10:20:30Z"}}', timeFields)).toBeNull();
  });

  it('documents nullable enum values as JSON Schema nulls', () => {
    const schema = whereFieldsToJsonSchema(transactionFilterFields) as {
      properties: { relation_type: { properties: { eq: { type: string[]; enum: unknown[] } } } };
    };
    expect(schema.properties.relation_type.properties.eq).toEqual({
      type: ['string', 'null'],
      enum: ['REVERSAL', 'CORRECTION', null],
    });
  });

  it('preserves the requested precision for every date operator', () => {
    for (const operator of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']) {
      for (const [fraction, parsed] of [
        ['', new Date('2025-01-01T08:20:30Z')],
        ['.123', new Date('2025-01-01T08:20:30.123Z')],
        ['.1230', { exactTimestamp: '2025-01-01T08:20:30.123000Z' }],
        ['.123456', { exactTimestamp: '2025-01-01T08:20:30.123456Z' }],
        ['.1234560', { exactTimestamp: '2025-01-01T08:20:30.123456Z' }],
        ['.1234567', null],
      ] as const) {
        const value = `2025-01-01T10:20:30${fraction}+02:00`;
        const where = JSON.stringify({
          created_at: { [operator]: operator === 'in' ? [value] : value },
        });
        expect(parseWhere<Record<string, unknown>>(where, accountFilterFields)).toEqual(
          parsed === null
            ? null
            : {
                createdAt: { [operator]: operator === 'in' ? [parsed] : parsed },
              },
        );
      }
    }
  });

  it('documents the same precision restriction for nullable and non-nullable dates', () => {
    const schema = whereFieldsToJsonSchema({
      created_at: { kind: 'date-time', ordered: true },
      expires_at: { kind: 'date-time', ordered: true, nullable: true },
    }) as {
      properties: Record<
        string,
        { properties: Record<string, { pattern?: string; items?: { pattern: string } }> }
      >;
    };
    for (const field of Object.values(schema.properties)) {
      for (const [operator, scalar] of Object.entries(field.properties)) {
        const pattern = operator === 'in' ? scalar.items?.pattern : scalar.pattern;
        expect(pattern).toBeDefined();
        const expression = new RegExp(pattern as string);
        expect(expression.test('2025-01-01T00:00:00.123000Z')).toBe(true);
        expect(expression.test('2025-01-01T00:00:00.123001Z')).toBe(true);
        expect(expression.test('2025-01-01T00:00:00.1230011Z')).toBe(false);
      }
    }
  });

  it('enforces enum, UUID, boolean and decimal integer wire types', () => {
    expect(parseWhere('{"side":{"eq":"DEBIT"}}', accountFilterFields)).not.toBeNull();
    expect(parseWhere('{"side":{"eq":"debit"}}', accountFilterFields)).toBeNull();
    expect(parseWhere('{"id":{"eq":"not-a-uuid"}}', accountFilterFields)).toBeNull();
    expect(parseWhere('{"grant_enabled":{"eq":true}}', accountFilterFields)).not.toBeNull();
    expect(parseWhere('{"grant_enabled":{"eq":"true"}}', accountFilterFields)).toBeNull();
    expect(parseWhere('{"balance_minor":{"gte":"0"}}', accountFilterFields)).not.toBeNull();
    expect(
      parseWhere('{"balance_minor":{"eq":"9223372036854775807"}}', accountFilterFields),
    ).not.toBeNull();
    expect(
      parseWhere('{"balance_minor":{"eq":"9223372036854775808"}}', accountFilterFields),
    ).toBeNull();
    expect(
      parseWhere('{"balance_minor":{"eq":"-9223372036854775809"}}', accountFilterFields),
    ).toBeNull();
    for (const value of ['1.2', '1e3', '+1', '01', '--1']) {
      expect(parseWhere(`{"balance_minor":{"gte":"${value}"}}`, accountFilterFields)).toBeNull();
    }
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']) {
      expect(parseWhere(`{"balance_minor":{"${op}":"-1"}}`, accountFilterFields)).not.toBeNull();
    }
  });

  it('accepts in arrays at the supported boundaries and rejects empty/oversized arrays', () => {
    const one = JSON.stringify({ name: { in: ['one'] } });
    const hundred = JSON.stringify({ name: { in: Array.from({ length: 100 }, (_, i) => `${i}`) } });
    const hundredOne = JSON.stringify({
      name: { in: Array.from({ length: 101 }, (_, i) => `${i}`) },
    });
    expect(parseWhere(one, accountFilterFields)).not.toBeNull();
    expect(parseWhere(hundred, accountFilterFields)).not.toBeNull();
    expect(parseWhere(hundredOne, accountFilterFields)).toBeNull();
    expect(parseWhere('{"name":{"in":[]}}', accountFilterFields)).toBeNull();
  });

  it('measures the decoded where payload limit in UTF-8 bytes', () => {
    const prefix = '{"name":{"eq":"';
    const suffix = '"}}';
    const atLimit = `${prefix}${'x'.repeat(MAX_WHERE_LENGTH - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(MAX_WHERE_LENGTH);
    expect(parseWhere(atLimit, accountFilterFields)).not.toBeNull();
    const overLimit = `${prefix}${'😀'.repeat(MAX_WHERE_LENGTH / 4)}${suffix}`;
    expect(new TextEncoder().encode(overLimit).byteLength).toBeGreaterThan(MAX_WHERE_LENGTH);
    expect(parseWhere(overLimit, accountFilterFields)).toBeNull();
  });
});
