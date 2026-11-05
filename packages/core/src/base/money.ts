import { CurrencyMismatchError, EmptyCurrencyError } from '@borecount/core/errors';
import { isNonEmptyString } from './string';

export class Money {
  public readonly amountMinor: bigint;
  public readonly currency: string;

  private constructor(amountMinor: bigint, currency: string) {
    if (!isNonEmptyString(currency)) {
      throw new EmptyCurrencyError();
    }

    this.amountMinor = amountMinor;
    this.currency = currency;
  }

  public static of(amountMinor: bigint, currency: string): Money {
    return new Money(amountMinor, currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  public negate(): Money {
    return new Money(-this.amountMinor, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
