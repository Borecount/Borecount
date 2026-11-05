import { describe, expect, it } from 'bun:test';
import {
  AccountNotFoundError,
  CreditGrantNotFoundError,
  ForbiddenError,
  HoldNotFoundError,
  InvariantViolationError,
  RateLimitExceededError,
  UnauthorizedError,
} from '@borecount/core/errors';
import Ajv from 'ajv';
import { rateLimitExceededResponseSchema, toHttpErrorPayload } from './errors';

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

  it('rejects objects merely resembling the canonical rate-limit error', () => {
    const error = Object.assign(new Error('private limiter internals'), {
      name: 'RateLimitExceededError',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSeconds: 7,
    });
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
  it('uses the declared status for validation, missing resources and access errors', () => {
    for (const [error, statusCode] of [
      [new InvariantViolationError('Invalid posting'), 400],
      [new CreditGrantNotFoundError('missing'), 404],
      [new HoldNotFoundError('missing'), 404],
      [new UnauthorizedError(), 401],
      [new ForbiddenError(), 403],
    ] as const) {
      expect(toHttpErrorPayload(error)).toMatchObject({ statusCode, error: error.code });
    }
  });

  it('maps canonical missing-account errors to 404', () => {
    expect(toHttpErrorPayload(new AccountNotFoundError('missing'))).toMatchObject({
      statusCode: 404,
      error: 'ACCOUNT_NOT_FOUND',
      message: 'Account not found: missing',
    });
  });

  it('does not trust an error that only resembles a domain error', () => {
    const error = Object.assign(new Error('private error details'), {
      code: 'UNBALANCED_TRANSACTION',
      httpStatus: 400,
    });

    expect(toHttpErrorPayload(error)).toEqual({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
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
