import { InvariantViolationError } from '@borecount/core/errors';
import { isNonEmptyString } from '../base/string';

export const assertNonEmpty = (value: string, message: string): void => {
  if (!isNonEmptyString(value)) {
    throw new InvariantViolationError(message);
  }
};
