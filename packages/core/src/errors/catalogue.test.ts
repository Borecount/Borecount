import { describe, expect, it } from 'bun:test';
import * as accountApi from '../account';
import * as applicationApi from '../application';
import * as baseApi from '../base';
import { Money } from '../base/money';
import * as creditGrantApi from '../credit-grant';
import * as rootApi from '../index';
import * as transactionApi from '../transaction';
import * as errors from './index';

describe('canonical error catalogue', () => {
  it('exposes error classes and guards only from the errors entry point', () => {
    const names = Object.keys(errors);
    expect(names).toContain('DomainError');
    expect(names).toContain('AccountNotFoundError');
    expect(names).toContain('RateLimitExceededError');
    for (const api of [
      rootApi,
      applicationApi,
      baseApi,
      accountApi,
      transactionApi,
      creditGrantApi,
    ]) {
      for (const name of names) expect(Object.keys(api)).not.toContain(name);
    }
  });

  it('uses one missing-account error with status 404', () => {
    const error = new errors.AccountNotFoundError('missing');
    expect(error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(error.httpStatus).toBe(404);
    expect(error.message).toBe('Account not found: missing');
  });

  it('uses the canonical currency mismatch message', () => {
    expect(() => Money.of(1n, '')).toThrow(errors.EmptyCurrencyError);
    try {
      Money.of(1n, 'USD').add(Money.of(1n, 'EUR'));
      throw new Error('Expected currency mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(errors.CurrencyMismatchError);
      expect((error as Error).message).toBe('Currency mismatch');
    }
    expect(new errors.CurrencyMismatchError().message).toBe('Currency mismatch');
  });

  it('validates retry delays and classifies resource errors through the shared base', () => {
    for (const seconds of [1, 42, Number.MAX_SAFE_INTEGER]) {
      const error = new errors.RateLimitExceededError(seconds);
      expect(error).toBeInstanceOf(errors.DomainError);
      expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(error.httpStatus).toBe(429);
      expect(error.retryAfterSeconds).toBe(seconds);
      expect(errors.isDomainError(error)).toBe(true);
    }
    for (const seconds of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new errors.RateLimitExceededError(seconds)).toThrow(RangeError);
    }
  });
});
