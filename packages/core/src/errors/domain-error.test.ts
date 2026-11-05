import { describe, expect, it } from 'bun:test';
import { DomainError, isDomainError } from './domain-error';
import { InvalidIdError, InvariantViolationError } from './index';

describe('isDomainError', () => {
  it('accepts instances of the canonical DomainError class', () => {
    expect(isDomainError(new InvariantViolationError('invalid posting'))).toBeTrue();
  });

  it('rejects database errors and objects that only imitate the public shape', () => {
    expect(isDomainError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBeFalse();
    expect(
      isDomainError(Object.assign(new Error('impostor'), { code: 'INVALID', httpStatus: 400 })),
    ).toBeFalse();
    expect(
      isDomainError(
        Object.assign(new Error('invalid status'), { code: 'INVALID', httpStatus: 200 }),
      ),
    ).toBeFalse();
  });
});

class CustomError extends DomainError {
  constructor(status: number) {
    super('Custom failure', 'CUSTOM', status);
  }
}

describe('DomainError status', () => {
  it('accepts client and server error statuses', () => {
    for (const status of [400, 429, 500, 599]) {
      expect(new CustomError(status).httpStatus).toBe(status);
    }
  });
  it('rejects invalid statuses', () => {
    for (const status of [200, 399, 600, 400.5, NaN, Infinity]) {
      expect(() => new CustomError(status)).toThrow(RangeError);
    }
  });
});

it('keeps invalid identifier values out of public messages', () => {
  expect(new InvalidIdError('AccountId').message).toBe('AccountId must be a non-empty string');
});

it('recognizes a branded error from another loaded copy of core', () => {
  class ForeignDomainError extends Error {
    readonly code = 'FOREIGN';
    readonly httpStatus = 409;
    constructor() {
      super('Conflict');
      Object.defineProperty(this, Symbol.for('borecount.domain-error'), { value: true });
    }
  }
  const error = new ForeignDomainError();
  expect(error instanceof DomainError).toBe(false);
  expect(isDomainError(error)).toBe(true);
  Object.assign(error, { httpStatus: 200 });
  expect(isDomainError(error)).toBe(false);
});
