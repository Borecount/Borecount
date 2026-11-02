import type {
  HoldCapture,
  HoldCreditAllocation,
  HoldEntry,
  HoldSummary,
} from '@borecount/core/application';
import type {
  HoldCaptureResponse,
  HoldCreditAllocationResponse,
  HoldEntryResponse,
  HoldSummaryResponse,
} from '../contracts/holds';

export const toHoldSummaryResponse = (hold: HoldSummary): HoldSummaryResponse => ({
  id: hold.id,
  ledger_id: hold.ledgerId,
  reference: hold.reference,
  currency: hold.currency,
  description: hold.description,
  state: hold.state,
  original_amount_minor: hold.originalAmountMinor.toString(),
  remaining_amount_minor: hold.remainingAmountMinor.toString(),
  created_at: hold.createdAt.toISOString(),
  applied_at: hold.appliedAt?.toISOString() ?? null,
  voided_at: hold.voidedAt?.toISOString() ?? null,
});

export const toHoldEntryResponse = (entry: HoldEntry): HoldEntryResponse => ({
  id: entry.id,
  account_id: entry.accountId,
  signed_amount_minor: entry.signedAmountMinor.toString(),
  currency: entry.currency,
  created_at: entry.createdAt.toISOString(),
});

export const toHoldCaptureResponse = (capture: HoldCapture): HoldCaptureResponse => ({
  id: capture.id,
  reference: capture.reference,
  amount_minor: capture.amountMinor.toString(),
  currency: capture.currency,
  created_at: capture.createdAt.toISOString(),
});

export const toHoldCreditAllocationResponse = (
  allocation: HoldCreditAllocation,
): HoldCreditAllocationResponse => ({
  id: allocation.id,
  hold_entry_id: allocation.holdEntryId,
  account_id: allocation.accountId,
  grant_id: allocation.grantId,
  amount_minor: allocation.amountMinor.toString(),
  created_at: allocation.createdAt.toISOString(),
});
