import { describe, expect, it } from 'bun:test';
import Ajv from 'ajv';
import {
  RateLimitExceededError,
  rateLimitExceededResponseSchema,
  toHttpErrorPayload,
} from './errors';

describe('host resource error contracts', () => {
  const ajv = new Ajv();
  const validateRate = ajv.compile(rateLimitExceededResponseSchema);

  it('maps a thrown HTTP error to the MVP body and matching retry header', () => {
    expect(toHttpErrorPayload(new RateLimitExceededError(42))).toEqual({
      statusCode: 429,
      headers: { 'Retry-After': '42' },
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      retry_after_seconds: 42,
    });
    for (const seconds of [1, 42, Number.MAX_SAFE_INTEGER]) {
      const error = new RateLimitExceededError(seconds);
      expect(error).toBeInstanceOf(Error);
      const { statusCode, headers, ...body } = toHttpErrorPayload(error);
      expect(statusCode).toBe(429);
      expect(headers).toEqual({ 'Retry-After': String(seconds) });
      expect(validateRate(body)).toBe(true);
    }
  });

  it('rejects invalid retry delays at construction and schema validation', () => {
    const valid = {
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      retry_after_seconds: 1,
    };
    for (const seconds of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new RateLimitExceededError(seconds)).toThrow(RangeError);
      expect(validateRate({ ...valid, retry_after_seconds: seconds })).toBe(false);
    }
    for (const invalid of [
      { error: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded' },
      { ...valid, retry_after_seconds: '1' },
      { ...valid, error: 429 },
      { ...valid, message: null },
      { ...valid, stack: 'private stack' },
    ]) {
      expect(validateRate(invalid)).toBe(false);
    }
  });

  it('maps the supported error shape across bundles without reflecting private messages', () => {
    const error = Object.assign(new Error('private limiter internals'), {
      name: 'RateLimitExceededError',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSeconds: 7,
    });
    expect(toHttpErrorPayload(error)).toEqual({
      statusCode: 429,
      headers: { 'Retry-After': '7' },
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      retry_after_seconds: 7,
    });
    error.retryAfterSeconds = 0;
    expect(toHttpErrorPayload(error)).toEqual({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
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
