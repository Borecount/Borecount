import { defineListFilter } from './list-filters';
import type { PaginationQuery } from './types';

export interface HoldSummary {
  id: string;
  ledgerId: string;
  reference: string;
  currency: string;
  description: string | null;
  state: 'HELD' | 'APPLIED' | 'VOIDED';
  originalAmountMinor: bigint;
  remainingAmountMinor: bigint;
  createdAt: Date;
  appliedAt: Date | null;
  voidedAt: Date | null;
}

export interface HoldEntry {
  id: string;
  accountId: string;
  signedAmountMinor: bigint;
  currency: string;
  createdAt: Date;
}

export interface HoldCapture {
  id: string;
  reference: string;
  amountMinor: bigint;
  currency: string;
  createdAt: Date;
}

export interface HoldCreditAllocation {
  id: string;
  holdEntryId: string;
  accountId: string;
  grantId: string;
  amountMinor: bigint;
  createdAt: Date;
}

type HoldListFilterModel = HoldSummary & { accountId: string };

export const holdListFilter = defineListFilter<HoldListFilterModel>()([]);
export const holdEntryListFilter = defineListFilter<HoldEntry>()([]);
export const holdCaptureListFilter = defineListFilter<HoldCapture>()([]);
export const holdCreditAllocationListFilter = defineListFilter<HoldCreditAllocation>()([]);

export type HoldListQuery = PaginationQuery<typeof holdListFilter>;
export interface HoldEntriesQuery extends PaginationQuery<typeof holdEntryListFilter> {
  holdId: string;
}
export interface HoldCapturesQuery extends PaginationQuery<typeof holdCaptureListFilter> {
  holdId: string;
}
export interface HoldCreditAllocationsQuery
  extends PaginationQuery<typeof holdCreditAllocationListFilter> {
  holdId: string;
}
