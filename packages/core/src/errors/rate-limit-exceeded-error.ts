import { DomainError } from './domain-error';

export class RateLimitExceededError extends DomainError {
  public readonly retryAfterSeconds: number;

  public constructor(retryAfterSeconds: number) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new RangeError('retryAfterSeconds must be a positive safe integer');
    }
    super('Rate limit exceeded', 'RATE_LIMIT_EXCEEDED', 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
