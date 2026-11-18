import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { HoldNotFoundError, InvariantViolationError } from '@borecount/core/errors';
import { sql } from 'drizzle-orm';
import { createApplicationServices } from '../../src/application-services';
import type { DbClient, DrizzleDatabase } from '../../src/client';
import {
  createLedger,
  createRepositoryTestClient,
  createRepositoryTestDatabase,
  createTenant,
  createAccount as insertAccount,
  migrateTestDatabase,
  truncateTestDatabase,
} from './repository-test-support';

const client = createRepositoryTestClient();
const db = createRepositoryTestDatabase(client);
const services = createApplicationServices(client);

const scopedClient = (tx: DrizzleDatabase): DbClient => ({
  sql: client.sql,
  execute: (operation, action) => client.execute(operation, () => action(tx)),
  runTx: (operation, action) => client.execute(operation, () => action(tx)),
  runTenantTx: (_tenant, operation, action) =>
    client.execute(operation, () => tx.transaction(action)),
});

async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ data: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

async function fixture(name = 'hold-reads') {
  const tenantId = await createTenant(db, name);
  const ledgerId = await createLedger(db, tenantId, 'Main');
  const wallet = await services.accounts.create({
    tenantId,
    ledgerId,
    name: 'Wallet',
    side: 'CREDIT',
    overdraftPolicy: 'DISALLOW',
    grantEnabled: true,
    currency: 'USD',
  });
  const funding = await services.accounts.create({
    tenantId,
    ledgerId,
    name: 'Funding',
    side: 'DEBIT',
    currency: 'USD',
  });
  const alternate = await services.accounts.create({
    tenantId,
    ledgerId,
    name: 'Alternate',
    side: 'DEBIT',
    currency: 'USD',
  });
  const grants = [];
  for (const [reference, amountMinor] of [
    ['grant-a', 70n],
    ['grant-b', 80n],
    ['grant-c', 100n],
  ] as const) {
    const result = await services.creditGrants.create({
      tenantId,
      ledgerId,
      accountId: wallet.id,
      fundingAccountId: funding.id,
      reference,
      amountMinor,
    });
    grants.push(result.grant);
  }
  const createHold = (reference: string, amount = 150n) =>
    services.holds.create({
      tenantId,
      ledgerId,
      currency: 'USD',
      reference,
      description: `Hold ${reference}`,
      entries: [
        { accountId: wallet.id, currency: 'USD', signedAmountMinor: amount },
        { accountId: funding.id, currency: 'USD', signedAmountMinor: -amount },
      ],
    });
  return { tenantId, ledgerId, wallet, funding, alternate, grants, createHold };
}

describe('HoldService reads against PostgreSQL', () => {
  beforeAll(() => migrateTestDatabase(db));
  beforeEach(() => truncateTestDatabase(db));
  afterAll(() => client.sql.end({ timeout: 5 }));

  it('reads a tenant-scoped summary and distinguishes missing, foreign, and empty children', async () => {
    const own = await fixture('hold-read-own');
    const foreign = await fixture('hold-read-foreign');
    const plainWalletId = await insertAccount(db, {
      tenantId: own.tenantId,
      ledgerId: own.ledgerId,
      name: 'Unfunded-by-grants wallet',
      side: 'CREDIT',
      currency: 'USD',
      balanceMinor: -100n,
    });
    const plainFundingId = await insertAccount(db, {
      tenantId: own.tenantId,
      ledgerId: own.ledgerId,
      name: 'Unfunded-by-grants funding',
      side: 'DEBIT',
      currency: 'USD',
      balanceMinor: 100n,
    });
    const hold = await own.createHold('lookup');
    const foreignHold = await foreign.createHold('hidden');
    const ordinaryHold = await services.holds.create({
      tenantId: own.tenantId,
      ledgerId: own.ledgerId,
      currency: 'USD',
      reference: 'ordinary',
      entries: [
        { accountId: plainWalletId, currency: 'USD', signedAmountMinor: 5n },
        { accountId: plainFundingId, currency: 'USD', signedAmountMinor: -5n },
      ],
    });

    expect(await services.holds.getById(own.tenantId, hold.holdId)).toMatchObject({
      id: hold.holdId,
      ledgerId: own.ledgerId,
      reference: 'lookup',
      currency: 'USD',
      description: 'Hold lookup',
      state: 'HELD',
      originalAmountMinor: 150n,
      remainingAmountMinor: 150n,
      appliedAt: null,
      voidedAt: null,
    });
    await expect(
      services.holds.getById(own.tenantId, '00000000-0000-4000-8000-000000000001'),
    ).rejects.toBeInstanceOf(HoldNotFoundError);
    await expect(services.holds.getById(foreign.tenantId, hold.holdId)).rejects.toBeInstanceOf(
      HoldNotFoundError,
    );
    expect(
      (await services.holds.listEntries({ tenantId: own.tenantId, holdId: hold.holdId, limit: 10 }))
        .data,
    ).toHaveLength(2);
    expect(
      await services.holds.listCaptures({ tenantId: own.tenantId, holdId: hold.holdId, limit: 10 }),
    ).toMatchObject({ data: [], nextCursor: null });
    const allocations = await services.holds.listCreditAllocations({
      tenantId: own.tenantId,
      holdId: hold.holdId,
      limit: 10,
    });
    expect(allocations.data).toHaveLength(2);
    expect(allocations.nextCursor).toBeNull();
    expect(
      await services.holds.listCreditAllocations({
        tenantId: own.tenantId,
        holdId: ordinaryHold.holdId,
        limit: 10,
      }),
    ).toMatchObject({ data: [], nextCursor: null });
    await expect(
      services.holds.listEntries({
        tenantId: own.tenantId,
        holdId: '00000000-0000-4000-8000-000000000001',
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(HoldNotFoundError);
    await expect(
      services.holds.listCaptures({
        tenantId: own.tenantId,
        holdId: foreignHold.holdId,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(HoldNotFoundError);
    await expect(
      services.holds.listCreditAllocations({
        tenantId: own.tenantId,
        holdId: foreignHold.holdId,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(HoldNotFoundError);
  });

  it('lists summaries in every lifecycle state and filters account membership with AND semantics', async () => {
    const f = await fixture('hold-list-states');
    const held = await f.createHold('held', 10n);
    const applied = await f.createHold('applied', 20n);
    const voided = await f.createHold('voided', 30n);
    await services.holds.commit({
      tenantId: f.tenantId,
      holdId: applied.holdId,
      reference: 'full',
    });
    await services.holds.void({ tenantId: f.tenantId, holdId: voided.holdId });

    const all = await collectPages((cursor) =>
      services.holds.list({ tenantId: f.tenantId, limit: 2, cursor }),
    );
    expect(all.map((item) => item.id)).toEqual([held.holdId, applied.holdId, voided.holdId].sort());
    expect(new Set(all.map((item) => item.state))).toEqual(new Set(['HELD', 'APPLIED', 'VOIDED']));

    const byBoth = await services.holds.list({
      tenantId: f.tenantId,
      limit: 10,
      where: {
        accountId: { eq: f.wallet.id, in: [f.wallet.id, f.funding.id], ne: f.alternate.id },
        state: { ne: 'VOIDED' },
      },
    });
    expect(byBoth.data.map((item) => item.id)).toEqual([held.holdId, applied.holdId].sort());
    expect(
      (
        await services.holds.list({
          tenantId: f.tenantId,
          limit: 10,
          where: { accountId: { eq: f.alternate.id } },
        })
      ).data,
    ).toEqual([]);
    expect(
      (
        await services.holds.list({
          tenantId: f.tenantId,
          limit: 10,
          where: { accountId: { ne: f.alternate.id } },
        })
      ).data.map((item) => item.id),
    ).toEqual(all.map((item) => item.id));
    const onlyWallet = await services.holds.list({
      tenantId: f.tenantId,
      limit: 10,
      where: { accountId: { eq: f.wallet.id } },
    });
    expect(onlyWallet.data.map((item) => item.id)).toEqual(all.map((item) => item.id));
    await expect(
      services.holds.list({
        tenantId: f.tenantId,
        limit: 10,
        where: { accountId: { gt: 1n } } as never,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('paginates each collection by id and binds cursors to tenant, parent, filters, and resource', async () => {
    const f = await fixture('hold-cursors');
    const hold = await f.createHold('cursor-parent', 150n);
    const otherHold = await f.createHold('cursor-other', 10n);
    // A 150 unit reservation spans the first two grants, yielding two allocation rows.
    const entryPage = await services.holds.listEntries({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 1,
    });
    expect(entryPage.data).toHaveLength(1);
    expect(entryPage.nextCursor).not.toBeNull();
    const secondEntry = await services.holds.listEntries({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 1,
      cursor: entryPage.nextCursor ?? undefined,
    });
    expect(secondEntry.data).toHaveLength(1);
    expect([entryPage.data[0]?.id, secondEntry.data[0]?.id]).toEqual(
      [entryPage.data[0]?.id, secondEntry.data[0]?.id].toSorted(),
    );
    const firstEntry = entryPage.data[0];
    if (!firstEntry) throw new Error('Expected a hold entry');
    const filteredEntries = await services.holds.listEntries({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 10,
      where: {
        id: { eq: firstEntry.id },
        signedAmountMinor: { eq: firstEntry.signedAmountMinor },
        createdAt: { gte: new Date(firstEntry.createdAt.getTime() - 1_000) },
      },
    });
    expect(filteredEntries.data).toEqual([firstEntry]);

    const allocationPage = await services.holds.listCreditAllocations({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 1,
    });
    expect(allocationPage.data).toHaveLength(1);
    expect(allocationPage.nextCursor).not.toBeNull();
    const allocationSecond = await services.holds.listCreditAllocations({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 1,
      cursor: allocationPage.nextCursor ?? undefined,
    });
    expect(allocationSecond.data).toHaveLength(1);
    const firstAllocation = allocationPage.data[0];
    if (!firstAllocation) throw new Error('Expected a credit allocation');
    const filteredAllocations = await services.holds.listCreditAllocations({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 10,
      where: {
        id: { eq: firstAllocation.id },
        amountMinor: { eq: firstAllocation.amountMinor },
        createdAt: { gte: new Date(firstAllocation.createdAt.getTime() - 1_000) },
      },
    });
    expect(filteredAllocations.data).toEqual([firstAllocation]);

    await services.holds.commit({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      reference: 'capture-a',
      amountMinor: 10n,
    });
    await services.holds.commit({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      reference: 'capture-b',
      amountMinor: 15n,
    });
    const capturePage = await services.holds.listCaptures({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 1,
    });
    expect(capturePage.data).toHaveLength(1);
    expect(capturePage.nextCursor).not.toBeNull();
    const captureSecond = await services.holds.listCaptures({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 1,
      cursor: capturePage.nextCursor ?? undefined,
    });
    expect(captureSecond.data).toHaveLength(1);
    expect([capturePage.data[0]?.id, captureSecond.data[0]?.id]).toEqual(
      [capturePage.data[0]?.id, captureSecond.data[0]?.id].toSorted(),
    );
    const laterCapture = captureSecond.data[0];
    if (!laterCapture) throw new Error('Expected a second capture');
    const filteredCaptures = await services.holds.listCaptures({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 10,
      where: {
        id: { eq: laterCapture.id },
        createdAt: { gte: new Date(laterCapture.createdAt.getTime() - 1_000) },
      },
    });
    expect(filteredCaptures.data).toEqual([laterCapture]);
    const captureAmountsEq = await services.holds.listCaptures({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 10,
      where: { amountMinor: { eq: 15n } },
    });
    expect(captureAmountsEq.data.map((item) => item.id)).toEqual([laterCapture.id]);
    const captureAmountsNe = await services.holds.listCaptures({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 10,
      where: { amountMinor: { ne: 15n } },
    });
    expect(captureAmountsNe.data.map((item) => item.amountMinor)).toEqual([10n]);
    const captureAmountsIn = await services.holds.listCaptures({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 10,
      where: { amountMinor: { in: [10n, 15n] } },
    });
    expect(captureAmountsIn.data).toHaveLength(2);
    const captureAmountsGte = await services.holds.listCaptures({
      tenantId: f.tenantId,
      holdId: hold.holdId,
      limit: 10,
      where: { amountMinor: { gte: 15n } },
    });
    expect(captureAmountsGte.data.map((item) => item.id)).toEqual([laterCapture.id]);

    const entryCursor = entryPage.nextCursor ?? undefined;
    await expect(
      services.holds.listEntries({
        tenantId: f.tenantId,
        holdId: hold.holdId,
        limit: 1,
        where: { currency: { eq: 'USD' } },
        cursor: entryCursor,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    const firstGrant = f.grants[0];
    if (!firstGrant) throw new Error('Expected a fixture grant');
    await expect(
      services.holds.listEntries({
        tenantId: f.tenantId,
        holdId: otherHold.holdId,
        limit: 1,
        cursor: entryCursor,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      services.holds.listEntries({
        tenantId: '00000000-0000-4000-8000-000000000003',
        holdId: hold.holdId,
        limit: 1,
        cursor: entryCursor,
      }),
    ).rejects.toBeDefined();
    await expect(
      services.holds.listCaptures({
        tenantId: f.tenantId,
        holdId: hold.holdId,
        limit: 1,
        cursor: entryCursor,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      services.holds.listCreditAllocations({
        tenantId: f.tenantId,
        holdId: hold.holdId,
        limit: 1,
        cursor: allocationPage.nextCursor ?? undefined,
        where: { grantId: { eq: firstGrant.id } },
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('replays captures and terminal reference recovery without duplicate read rows, and leaves reads unchanged after conflicting retries', async () => {
    const f = await fixture('hold-replay');
    const hold = await f.createHold('replay', 90n);
    const command = {
      tenantId: f.tenantId,
      holdId: hold.holdId,
      reference: 'partial',
      amountMinor: 20n,
    };
    const allocationsBefore = await collectPages((cursor) =>
      services.holds.listCreditAllocations({
        tenantId: f.tenantId,
        holdId: hold.holdId,
        limit: 10,
        cursor,
      }),
    );
    const first = await services.holds.commit(command);
    expect(first.created).toBeTrue();
    expect(await services.holds.commit(command)).toMatchObject({ created: false });
    await services.holds.commit({ ...command, reference: 'partial-2', amountMinor: 10n });
    const beforeConflict = await collectPages((cursor) =>
      services.holds.listCaptures({ tenantId: f.tenantId, holdId: hold.holdId, limit: 10, cursor }),
    );
    await expect(services.holds.commit({ ...command, amountMinor: 21n })).rejects.toBeDefined();
    expect(
      await collectPages((cursor) =>
        services.holds.listCaptures({
          tenantId: f.tenantId,
          holdId: hold.holdId,
          limit: 10,
          cursor,
        }),
      ),
    ).toEqual(beforeConflict);
    await services.holds.void({ tenantId: f.tenantId, holdId: hold.holdId });
    const recovery = await f.createHold('replay', 90n);
    expect(recovery).toMatchObject({ created: false, holdId: hold.holdId, state: 'VOIDED' });
    expect(
      await collectPages((cursor) =>
        services.holds.listCaptures({
          tenantId: f.tenantId,
          holdId: hold.holdId,
          limit: 10,
          cursor,
        }),
      ),
    ).toHaveLength(2);
    expect(
      await collectPages((cursor) =>
        services.holds.listCreditAllocations({
          tenantId: f.tenantId,
          holdId: hold.holdId,
          limit: 10,
          cursor,
        }),
      ),
    ).toEqual(allocationsBefore);
    expect(await services.holds.getById(f.tenantId, hold.holdId)).toMatchObject({
      state: 'VOIDED',
    });
  });

  it('keeps keyset continuation usable across a hold state transition and a later insert', async () => {
    const f = await fixture('hold-live-pagination');
    const first = await f.createHold('page-a', 10n);
    const second = await f.createHold('page-b', 10n);
    const page = await services.holds.list({
      tenantId: f.tenantId,
      limit: 1,
      where: { state: { eq: 'HELD' } },
    });
    expect(page.data[0]?.id).toBe(first.holdId);
    await services.holds.commit({
      tenantId: f.tenantId,
      holdId: first.holdId,
      reference: 'apply-first',
    });
    const third = await f.createHold('page-c', 10n);
    const following = await services.holds.list({
      tenantId: f.tenantId,
      limit: 2,
      where: { state: { eq: 'HELD' } },
      cursor: page.nextCursor ?? undefined,
    });
    expect(following.data.map((item) => item.id)).toEqual([second.holdId, third.holdId].sort());
    await expect(
      services.holds.list({
        tenantId: f.tenantId,
        limit: 2,
        where: { state: { eq: 'HELD' }, reference: { eq: 'page-c' } },
        cursor: page.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      services.holds.list({
        tenantId: '00000000-0000-4000-8000-000000000003',
        limit: 2,
        where: { state: { eq: 'HELD' } },
        cursor: page.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('returns indistinguishable 404 reads through a non-bypass RLS role', async () => {
    const own = await fixture('hold-role-own');
    const foreign = await fixture('hold-role-foreign');
    const ownHold = await own.createHold('role-hidden');
    const hidden = await foreign.createHold('role-hidden');
    const absent = '00000000-0000-4000-8000-000000000099';
    const rollback = new Error('rollback hold read role fixture');
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`CREATE ROLE ll115_hold_reader NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        await tx.execute(sql`GRANT USAGE ON SCHEMA public TO ll115_hold_reader`);
        await tx.execute(sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ll115_hold_reader`);
        await tx.execute(sql`SET LOCAL ROLE ll115_hold_reader`);
        await tx.execute(sql`select set_config('app.tenant_id', ${own.tenantId}, true)`);
        const runtime = createApplicationServices(scopedClient(tx));
        expect(await runtime.holds.getById(own.tenantId, ownHold.holdId)).toMatchObject({
          id: ownHold.holdId,
          reference: 'role-hidden',
        });
        expect(
          (
            await runtime.holds.list({
              tenantId: own.tenantId,
              limit: 10,
              where: { reference: { eq: 'role-hidden' } },
            })
          ).data.map((hold) => hold.id),
        ).toEqual([ownHold.holdId]);
        const foreignFailure = await runtime.holds.getById(foreign.tenantId, hidden.holdId).then(
          () => null,
          (error: unknown) => error,
        );
        const absentFailure = await runtime.holds.getById(own.tenantId, absent).then(
          () => null,
          (error: unknown) => error,
        );
        expect(foreignFailure).toBeInstanceOf(HoldNotFoundError);
        expect(absentFailure).toBeInstanceOf(HoldNotFoundError);
        expect((foreignFailure as Error).message).toBe((absentFailure as Error).message);
        const foreignEntriesFailure = await runtime.holds
          .listEntries({ tenantId: foreign.tenantId, holdId: hidden.holdId, limit: 10 })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(foreignEntriesFailure).toBeInstanceOf(HoldNotFoundError);
        expect((foreignEntriesFailure as Error).message).toBe((absentFailure as Error).message);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
