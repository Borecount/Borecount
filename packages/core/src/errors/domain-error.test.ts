import { describe, expect, it } from 'bun:test';
import { isDomainError } from './domain-error';
import { InvariantViolationError } from './index';

describe('isDomainError', () => {
  it('accepts domain errors by stable public shape', () => {
    expect(isDomainError(new InvariantViolationError('invalid posting'))).toBeTrue();
  });

  it('rejects database-like and malformed errors', () => {
    expect(isDomainError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBeFalse();
    expect(
      isDomainError(
        Object.assign(new Error('invalid status'), { code: 'INVALID', httpStatus: 200 }),
      ),
    ).toBeFalse();
  });
});
