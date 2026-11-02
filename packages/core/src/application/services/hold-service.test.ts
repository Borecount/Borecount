import { describe, expect, it } from 'bun:test';

import {
  type HoldApplicationRepository,
  HoldNotFoundError,
  HoldService,
  type HoldSummary,
  InvariantViolationError,
} from '@borecount/core/application';

const hold: HoldSummary = {
  id: 'hold-1',
  ledgerId: 'ledger-1',
  reference: 'reserve-1',
  currency: 'USD',
  description: null,
  state: 'HELD',
  originalAmountMinor: 500n,
  remainingAmountMinor: 500n,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  appliedAt: null,
  voidedAt: null,
};

const createRepository = () => {
  const calls: Record<string, unknown[]> = {
    findById: [],
    list: [],
    listEntries: [],
    listCaptures: [],
    listCreditAllocations: [],
  };
  const repository: HoldApplicationRepository = {
    create: async () => ({
      holdId: hold.id,
      created: true,
      state: 'HELD',
      remainingAmountMinor: hold.remainingAmountMinor,
    }),
    commit: async () => ({
      holdId: hold.id,
      state: 'APPLIED',
      remainingAmountMinor: 0n,
      transactionId: 'transaction-1',
      created: true,
    }),
    void: async () => ({
      holdId: hold.id,
      state: 'VOIDED',
      remainingAmountMinor: 0n,
      voided: true,
    }),
    findById: async (...args) => {
      calls.findById.push(args);
      return args[1] === hold.id ? hold : null;
    },
    list: async (query) => {
      calls.list.push(query);
      return { data: [hold], nextCursor: null };
    },
    listEntries: async (query) => {
      calls.listEntries.push(query);
      return { data: [], nextCursor: null };
    },
    listCaptures: async (query) => {
      calls.listCaptures.push(query);
      return { data: [], nextCursor: null };
    },
    listCreditAllocations: async (query) => {
      calls.listCreditAllocations.push(query);
      return { data: [], nextCursor: null };
    },
  };
  return { repository, calls };
};

describe('HoldService reads', () => {
  it('loads a hold and forwards validated list queries to the repository', async () => {
    const { repository, calls } = createRepository();
    const service = new HoldService(repository);

    expect(await service.getById('tenant-1', hold.id)).toBe(hold);
    expect(
      await service.list({
        tenantId: 'tenant-1',
        limit: 25,
        where: { state: { eq: 'HELD' }, accountId: { eq: 'account-1' } },
      }),
    ).toEqual({ data: [hold], nextCursor: null });
    await service.listEntries({ tenantId: 'tenant-1', holdId: hold.id, limit: 25 });
    await service.listCaptures({ tenantId: 'tenant-1', holdId: hold.id, limit: 25 });
    await service.listCreditAllocations({ tenantId: 'tenant-1', holdId: hold.id, limit: 25 });

    expect(calls.findById).toEqual([['tenant-1', hold.id]]);
    expect(calls.list).toHaveLength(1);
    expect(calls.listEntries).toHaveLength(1);
    expect(calls.listCaptures).toHaveLength(1);
    expect(calls.listCreditAllocations).toHaveLength(1);
  });

  it('reports missing holds and rejects invalid scope, pagination, filters, and child hold IDs', async () => {
    const { repository, calls } = createRepository();
    const service = new HoldService(repository);

    await expect(service.getById('tenant-1', 'missing')).rejects.toBeInstanceOf(HoldNotFoundError);
    await expect(service.getById(' ', hold.id)).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(service.list({ tenantId: 'tenant-1', limit: 0 })).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
    await expect(
      service.list({
        tenantId: 'tenant-1',
        limit: 10,
        where: { reference: { lt: 'x' } } as never,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      service.listEntries({ tenantId: 'tenant-1', holdId: ' ', limit: 10 }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      service.listCaptures({ tenantId: 'tenant-1', holdId: '', limit: 10 }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      service.listCreditAllocations({ tenantId: 'tenant-1', holdId: '', limit: 10 }),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    expect(calls.list).toHaveLength(0);
    expect(calls.listEntries).toHaveLength(0);
    expect(calls.listCaptures).toHaveLength(0);
    expect(calls.listCreditAllocations).toHaveLength(0);
  });
});
