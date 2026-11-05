import { describe, expect, it } from 'bun:test';
import Ajv from 'ajv';
import {
  rateLimitExceededPayload,
  rateLimitExceededResponseSchema,
  requestTooLargePayload,
  requestTooLargeResponseSchema,
  toHttpErrorPayload,
} from './errors';

describe('host resource error contracts', () => {
  const ajv = new Ajv();
  const validateRate = ajv.compile(rateLimitExceededResponseSchema);
  const validateSize = ajv.compile(requestTooLargeResponseSchema);

  it('preserves the MVP throttle payload and accepts positive safe retry delays', () => {
    expect(rateLimitExceededPayload(42)).toEqual({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      retry_after_seconds: 42,
    });
    for (const seconds of [1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(validateRate(rateLimitExceededPayload(seconds))).toBe(true);
    }
  });

  it('rejects invalid retry delays at construction and schema validation', () => {
    for (const seconds of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => rateLimitExceededPayload(seconds)).toThrow(RangeError);
      expect(validateRate({ ...rateLimitExceededPayload(1), retry_after_seconds: seconds })).toBe(
        false,
      );
    }
    for (const invalid of [
      { error: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded' },
      { ...rateLimitExceededPayload(1), retry_after_seconds: '1' },
      { ...rateLimitExceededPayload(1), error: 'INTERNAL_ERROR' },
      { ...rateLimitExceededPayload(1), message: 'secret database details' },
      { ...rateLimitExceededPayload(1), details: { secret: 'value' } },
    ]) {
      expect(validateRate(invalid)).toBe(false);
    }
  });

  it('provides a deterministic size error without reflecting framework or request details', () => {
    expect(requestTooLargePayload()).toEqual({
      error: 'REQUEST_TOO_LARGE',
      message: 'Request too large',
    });
    expect(validateSize(requestTooLargePayload())).toBe(true);
    for (const invalid of [
      { error: 'REQUEST_TOO_LARGE' },
      { ...requestTooLargePayload(), error: 'INVALID_INPUT' },
      { ...requestTooLargePayload(), message: 'secret request details' },
      { ...requestTooLargePayload(), stack: 'private stack' },
    ]) {
      expect(validateSize(invalid)).toBe(false);
    }
  });

  it('does not recognize framework errors as trusted domain errors', () => {
    for (const code of ['FST_ERR_CTP_BODY_TOO_LARGE', 'RATE_LIMIT_EXCEEDED', 'REQUEST_TOO_LARGE']) {
      expect(toHttpErrorPayload(Object.assign(new Error('private details'), { code }))).toEqual({
        statusCode: 500,
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    }
  });
});

describe('toHttpErrorPayload', () => {
  it('maps structurally compatible domain errors from another public export identity', () => {
    const error = Object.assign(new Error('total debits must equal total credits'), {
      code: 'UNBALANCED_TRANSACTION',
      httpStatus: 400,
    });

    expect(toHttpErrorPayload(error)).toEqual({
      statusCode: 400,
      error: 'UNBALANCED_TRANSACTION',
      message: 'total debits must equal total credits',
      details: undefined,
    });
  });

  it('hides raw database errors even when they expose code and message', () => {
    const error = Object.assign(new Error('duplicate key violates transactions_reference_key'), {
      code: '23505',
      constraint_name: 'transactions_reference_key',
    });

    expect(toHttpErrorPayload(error)).toEqual({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
