import { describe, expect, it } from 'bun:test';
import type {
  HoldCapture,
  HoldCreditAllocation,
  HoldEntry,
  HoldSummary,
} from '@borecount/core/application';
import {
  toHoldCaptureResponse,
  toHoldCreditAllocationResponse,
  toHoldEntryResponse,
  toHoldSummaryResponse,
} from './holds';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

describe('hold response mappers', () => {
  it('serializes summary amounts and nullable timestamps without nested data', () => {
    const summary: HoldSummary = {
      id: 'hold-id',
      ledgerId: 'ledger-id',
      reference: 'hold-ref',
      currency: 'USD',
      description: null,
      state: 'HELD',
      originalAmountMinor: 1200n,
      remainingAmountMinor: 900n,
      createdAt,
      appliedAt: null,
      voidedAt: null,
    };

    expect(toHoldSummaryResponse(summary)).toEqual({
      id: 'hold-id',
      ledger_id: 'ledger-id',
      reference: 'hold-ref',
      currency: 'USD',
      description: null,
      state: 'HELD',
      original_amount_minor: '1200',
      remaining_amount_minor: '900',
      created_at: '2026-01-01T00:00:00.000Z',
      applied_at: null,
      voided_at: null,
    });
  });

  it('serializes entries, posted captures, and immutable credit allocations', () => {
    const entry: HoldEntry = {
      id: 'entry-id',
      accountId: 'account-id',
      signedAmountMinor: -1200n,
      currency: 'USD',
      createdAt,
    };
    const capture: HoldCapture = {
      id: 'transaction-id',
      reference: 'capture-ref',
      amountMinor: 300n,
      currency: 'USD',
      createdAt,
    };
    const allocation: HoldCreditAllocation = {
      id: 'allocation-id',
      holdEntryId: 'entry-id',
      accountId: 'account-id',
      grantId: 'grant-id',
      amountMinor: 700n,
      createdAt,
    };

    expect(toHoldEntryResponse(entry)).toEqual({
      id: 'entry-id',
      account_id: 'account-id',
      signed_amount_minor: '-1200',
      currency: 'USD',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(toHoldCaptureResponse(capture)).toEqual({
      id: 'transaction-id',
      reference: 'capture-ref',
      amount_minor: '300',
      currency: 'USD',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(toHoldCreditAllocationResponse(allocation)).toEqual({
      id: 'allocation-id',
      hold_entry_id: 'entry-id',
      account_id: 'account-id',
      grant_id: 'grant-id',
      amount_minor: '700',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });
});
