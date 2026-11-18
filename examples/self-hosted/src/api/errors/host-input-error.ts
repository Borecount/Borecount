import { DomainError } from '@borecount/core/errors';

/** Host validation error using the public governed error contract. */
export class HostInputError extends DomainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'INVALID_INPUT', 400, options);
  }
}
