import { DomainError } from './domain-error';

export class InvalidIdError extends DomainError {
  public constructor(name: string) {
    super(`${name} must be a non-empty string`, 'INVALID_ID');
  }
}

export class EmptyCurrencyError extends DomainError {
  public constructor() {
    super('Currency is required', 'CURRENCY_REQUIRED');
  }
}

export class InvalidCreditGrantError extends DomainError {
  public constructor(message: string) {
    super(message, 'INVALID_CREDIT_GRANT');
  }
}
