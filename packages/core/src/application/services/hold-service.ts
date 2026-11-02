import { assertNonEmpty } from '../../utils';
import { HoldNotFoundError, InvariantViolationError } from '../errors';
import type {
  HoldCapture,
  HoldCapturesQuery,
  HoldCreditAllocation,
  HoldCreditAllocationsQuery,
  HoldEntriesQuery,
  HoldEntry,
  HoldListQuery,
  HoldSummary,
} from '../hold-reads';
import {
  holdCaptureListFilter,
  holdCreditAllocationListFilter,
  holdEntryListFilter,
  holdListFilter,
} from '../hold-reads';
import { validateListWhere } from '../list-filters';
import { validatePaginationQuery } from '../pagination-query';
import type { HoldApplicationRepository } from '../repositories.interface';
import type {
  CommitHoldInput,
  CommitHoldResult,
  CreateHoldInput,
  CreateHoldResult,
  PaginatedResult,
  VoidHoldInput,
  VoidHoldResult,
} from '../types';

export class HoldService {
  public constructor(private readonly repository: HoldApplicationRepository) {}

  public async getById(tenantId: string, holdId: string): Promise<HoldSummary> {
    assertNonEmpty(tenantId, 'tenantId is required');
    assertNonEmpty(holdId, 'hold id is required');
    const hold = await this.repository.findById(tenantId, holdId);
    if (!hold) throw new HoldNotFoundError(holdId);
    return hold;
  }

  public async list(query: HoldListQuery): Promise<PaginatedResult<HoldSummary>> {
    validatePaginationQuery(query);
    validateListWhere(holdListFilter, query.where);
    return this.repository.list(query);
  }

  public async listEntries(query: HoldEntriesQuery): Promise<PaginatedResult<HoldEntry>> {
    validatePaginationQuery(query);
    assertNonEmpty(query.holdId, 'holdId is required');
    validateListWhere(holdEntryListFilter, query.where);
    return this.repository.listEntries(query);
  }

  public async listCaptures(query: HoldCapturesQuery): Promise<PaginatedResult<HoldCapture>> {
    validatePaginationQuery(query);
    assertNonEmpty(query.holdId, 'holdId is required');
    validateListWhere(holdCaptureListFilter, query.where);
    return this.repository.listCaptures(query);
  }

  public async listCreditAllocations(
    query: HoldCreditAllocationsQuery,
  ): Promise<PaginatedResult<HoldCreditAllocation>> {
    validatePaginationQuery(query);
    assertNonEmpty(query.holdId, 'holdId is required');
    validateListWhere(holdCreditAllocationListFilter, query.where);
    return this.repository.listCreditAllocations(query);
  }

  public async create(input: CreateHoldInput): Promise<CreateHoldResult> {
    assertNonEmpty(input.tenantId, 'tenantId is required');
    assertNonEmpty(input.ledgerId, 'ledgerId is required');
    assertNonEmpty(input.reference, 'reference is required');
    assertNonEmpty(input.currency, 'currency is required');
    if (typeof input.description === 'string') {
      assertNonEmpty(input.description, 'description must be a non-empty string');
    }
    return this.repository.create(input);
  }

  public async commit(input: CommitHoldInput): Promise<CommitHoldResult> {
    assertNonEmpty(input.tenantId, 'tenantId is required');
    assertNonEmpty(input.holdId, 'holdId is required');
    assertNonEmpty(input.reference, 'reference is required');
    if (input.amountMinor !== undefined && input.amountMinor <= 0n) {
      throw new InvariantViolationError('amountMinor must be positive when provided');
    }
    return this.repository.commit(input);
  }

  public async void(input: VoidHoldInput): Promise<VoidHoldResult> {
    assertNonEmpty(input.tenantId, 'tenantId is required');
    assertNonEmpty(input.holdId, 'holdId is required');
    return this.repository.void(input);
  }
}
