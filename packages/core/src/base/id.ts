import { InvalidIdError } from '@borecount/core/errors';
import { isNonEmptyString } from './string';

export abstract class Id {
  public readonly value: string;

  protected constructor(value: string, name: string) {
    if (!isNonEmptyString(value)) {
      throw new InvalidIdError(name, value);
    }

    this.value = value;
  }

  public toString(): string {
    return this.value;
  }
}

export class TenantId extends Id {
  public constructor(value: string) {
    super(value, 'TenantId');
  }
}

export class LedgerId extends Id {
  public constructor(value: string) {
    super(value, 'LedgerId');
  }
}

export class AccountId extends Id {
  public constructor(value: string) {
    super(value, 'AccountId');
  }
}

export class TransactionId extends Id {
  public constructor(value: string) {
    super(value, 'TransactionId');
  }
}
