import { describe, expect, it } from 'bun:test';
import { isDomainError } from './domain-error';
import { InvariantViolationError } from './index';

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
