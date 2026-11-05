import { describe, expect, it } from 'bun:test';
import { OverdraftPolicyViolationError } from '@borecount/core/errors';
import { assertAvailableBalance } from './available-balance';

describe('assertAvailableBalance', () => {
  const account = {
    id: 'account-1',
    side: 'CREDIT' as const,
    overdraftPolicy: 'DISALLOW' as const,
    balanceMinor: -100n,
    reservedDeltaMinor: 70n,
  };

  it('accepts zero available balance', () => {
    expect(() => assertAvailableBalance({ ...account, reservedDeltaMinor: 100n })).not.toThrow();
  });

  it('rejects negative available balance for DISALLOW', () => {
    expect(() => assertAvailableBalance({ ...account, reservedDeltaMinor: 101n })).toThrow(
      OverdraftPolicyViolationError,
    );
  });

  it('keeps ALLOW permissive', () => {
    expect(() =>
      assertAvailableBalance({ ...account, overdraftPolicy: 'ALLOW', reservedDeltaMinor: 101n }),
    ).not.toThrow();
  });
});
