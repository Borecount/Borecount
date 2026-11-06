import { isNonEmptyString } from '../base/string';
import { InvariantViolationError } from '../errors';

export const assertNonEmpty = (value: string, message: string): void => {
  if (!isNonEmptyString(value)) {
    throw new InvariantViolationError(message);
  }
};
