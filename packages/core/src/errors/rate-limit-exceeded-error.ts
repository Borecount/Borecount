import { DomainError, isDomainError } from './domain-error';

const RATE_LIMIT_ERROR_BRAND = Symbol.for('borecount.rate-limit-exceeded-error');

export class RateLimitExceededError extends DomainError {
  public readonly retryAfterSeconds: number;

  public constructor(retryAfterSeconds: number) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new RangeError('retryAfterSeconds must be a positive safe integer');
    }
    super('Rate limit exceeded', 'RATE_LIMIT_EXCEEDED', 429);
    Object.defineProperty(this, RATE_LIMIT_ERROR_BRAND, { value: true });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const isRateLimitExceededError = (error: unknown): error is RateLimitExceededError => {
  if (!isDomainError(error)) return false;
  const candidate = error as RateLimitExceededError & { [RATE_LIMIT_ERROR_BRAND]?: unknown };
  return (
    candidate[RATE_LIMIT_ERROR_BRAND] === true &&
    candidate.code === 'RATE_LIMIT_EXCEEDED' &&
    candidate.httpStatus === 429 &&
    Number.isSafeInteger(candidate.retryAfterSeconds) &&
    candidate.retryAfterSeconds >= 1
  );
};
