import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { AccountSide } from '@borecount/core';
import {
  AssetCodeConflictError,
  AssetNotFoundError,
  InvariantViolationError,
} from '@borecount/core/errors';
import { eq, sql } from 'drizzle-orm';
import { createApplicationServices } from '../../src/application-services';
import { accounts, assets, entries, transactions } from '../../src/schema';
import {
  createLedger,
  createRepositoryTestClient,
  createRepositoryTestDatabase,
  createTenant,
  migrateTestDatabase,
  truncateTestDatabase,
} from './repository-test-support';

const client = createRepositoryTestClient();
const db = createRepositoryTestDatabase(client);
const services = createApplicationServices(client);

describe('tenant assets', () => {
  beforeAll(() => migrateTestDatabase(db));
  beforeEach(() => truncateTestDatabase(db));
  afterAll(() => client.sql.end({ timeout: 5 }));

  it('creates CREDIT and EUR with stable tenant identity and immutable scale', async () => {
    const tenantId = await createTenant(db, 'A');
    const otherTenantId = await createTenant(db, 'B');
    const credit = await services.assets.create({ tenantId, code: 'CREDIT', scale: 0 });
    const euro = await services.assets.create({ tenantId, code: 'EUR', scale: 2 });
    const otherCredit = await services.assets.create({
      tenantId: otherTenantId,
      code: 'CREDIT',
      scale: 0,
    });
    expect(credit.id).not.toBe(otherCredit.id);
    expect((await services.assets.list({ tenantId, limit: 50 })).data).toHaveLength(3);
    expect((await services.assets.getById(tenantId, euro.id)).scale).toBe(2);
    await expect(services.assets.getById(otherTenantId, euro.id)).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
    await expect(
      services.assets.create({ tenantId, code: 'CREDIT', scale: 0 }),
    ).rejects.toBeInstanceOf(AssetCodeConflictError);
    await expect(
      services.assets.create({ tenantId, code: 'eur', scale: 2 }),
    ).rejects.toBeInstanceOf(AssetCodeConflictError);
    await expect(
      (async () => {
        await db.update(assets).set({ scale: 3 }).where(eq(assets.id, euro.id));
      })(),
    ).rejects.toThrow();
  });

  it('filters creation times at the requested precision and scopes cursors to that precision', async () => {
    const tenantId = await createTenant(db, 'A');
    const euro = await services.assets.create({ tenantId, code: 'EUR', scale: 2 });
    await db
      .update(assets)
      .set({ createdAt: sql`TIMESTAMPTZ '2026-01-01 00:00:00.123456+00'` })
      .where(eq(assets.id, euro.id));

    const { createdAt } = await services.assets.getById(tenantId, euro.id);
    expect(createdAt.toISOString()).toBe('2026-01-01T00:00:00.123Z');
    for (const [code, timestamp] of [
      ['AAA', '2026-01-01T00:00:00.122999Z'],
      ['BBB', '2026-01-01T00:00:00.123000Z'],
      ['CCC', '2026-01-01T00:00:00.123999Z'],
      ['DDD', '2026-01-01T00:00:00.124000Z'],
    ] as const) {
      const asset = await services.assets.create({ tenantId, code, scale: 2 });
      await db
        .update(assets)
        .set({ createdAt: sql`${timestamp}::timestamptz` })
        .where(eq(assets.id, asset.id));
    }
    for (const [operator, expected] of [
      ['eq', ['BBB', 'CCC', 'EUR']],
      ['ne', ['AAA', 'DDD']],
      ['gt', ['DDD']],
      ['gte', ['BBB', 'CCC', 'DDD', 'EUR']],
      ['lt', ['AAA']],
      ['lte', ['AAA', 'BBB', 'CCC', 'EUR']],
      ['in', ['BBB', 'CCC', 'EUR']],
    ] as const) {
      const value = operator === 'in' ? [createdAt] : createdAt;
      const page = await services.assets.list({
        tenantId,
        limit: 50,
        where: { code: { ne: 'USD' }, createdAt: { [operator]: value } },
      });
      expect(page.data.map((asset) => asset.code)).toEqual([...expected]);
    }
    const exactMatch = { exactTimestamp: '2026-01-01T00:00:00.123456Z' };
    const exactMiss = { exactTimestamp: '2026-01-01T00:00:00.123000Z' };
    for (const [createdAtFilter, expected] of [
      [{ eq: exactMatch }, [euro.id]],
      [{ eq: exactMiss }, []],
      [{ gt: exactMiss }, [euro.id]],
      [{ lte: exactMiss }, []],
      [{ in: [exactMiss, createdAt] }, [euro.id]],
    ] as const) {
      const page = await services.assets.list({
        tenantId,
        limit: 50,
        where: { code: { eq: 'EUR' }, createdAt: createdAtFilter },
      });
      expect(page.data.map((asset) => asset.id)).toEqual([...expected]);
    }
    const first = await services.assets.list({
      tenantId,
      limit: 1,
      where: { createdAt: { gte: createdAt } },
    });
    if (!first.nextCursor) throw new Error('Expected an asset cursor');
    await expect(
      services.assets.list({
        tenantId,
        limit: 1,
        cursor: first.nextCursor,
        where: { createdAt: { gte: exactMiss } },
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('scopes asset cursors to the tenant, filters, and resource', async () => {
    const tenantId = await createTenant(db, 'A');
    const otherTenantId = await createTenant(db, 'B');
    await services.assets.create({ tenantId, code: ' euR ', scale: 2 });
    await services.assets.create({ tenantId, code: 'CREDIT', scale: 0 });
    await services.assets.create({ tenantId: otherTenantId, code: 'JPY', scale: 0 });

    const query = { tenantId, limit: 1, where: { scale: { eq: 2 } } };
    const first = await services.assets.list(query);
    expect(first.data.map((asset) => asset.code)).toEqual(['EUR']);
    if (!first.nextCursor) throw new Error('Expected an asset cursor');
    const cursor = first.nextCursor;
    const second = await services.assets.list({ ...query, cursor });
    expect(second.data.map((asset) => asset.code)).toEqual(['USD']);
    expect(second.nextCursor).toBeNull();
    await expect(
      services.assets.list({ ...query, tenantId: otherTenantId, cursor }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      services.assets.list({ ...query, where: { scale: { eq: 0 } }, cursor }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(services.ledgers.list({ tenantId, limit: 1, cursor })).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
  });

  it('posts and retries one asset, rejects mixed and cross-tenant identities', async () => {
    const tenantId = await createTenant(db, 'A');
    const otherTenantId = await createTenant(db, 'B');
    const ledgerId = await createLedger(db, tenantId, 'Main');
    const credit = await services.assets.create({ tenantId, code: 'CREDIT', scale: 0 });
    const euro = await services.assets.create({ tenantId, code: 'EUR', scale: 2 });
    const otherCredit = await services.assets.create({
      tenantId: otherTenantId,
      code: 'CREDIT',
      scale: 0,
    });
    const debit = await services.accounts.create({
      tenantId,
      ledgerId,
      name: 'Debit',
      side: AccountSide.DEBIT,
      currency: 'CREDIT',
      assetId: credit.id,
    });
    const contra = await services.accounts.create({
      tenantId,
      ledgerId,
      name: 'Contra',
      side: AccountSide.CREDIT,
      currency: 'CREDIT',
    });
    const eurAccount = await services.accounts.create({
      tenantId,
      ledgerId,
      name: 'Euro',
      side: AccountSide.DEBIT,
      currency: 'EUR',
      assetId: euro.id,
    });
    expect(debit.assetId).toBe(credit.id);
    expect(contra.assetId).toBe(credit.id);
    await expect(
      services.accounts.create({
        tenantId,
        ledgerId,
        name: 'Bad',
        side: AccountSide.DEBIT,
        currency: 'CREDIT',
        assetId: otherCredit.id,
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await db
      .update(accounts)
      .set({ assetId: credit.id, currency: 'CREDIT' })
      .where(eq(accounts.id, debit.id));

    const input = {
      tenantId,
      ledgerId,
      reference: 'credit-post',
      currency: 'CREDIT',
      entries: [
        {
          accountId: debit.id,
          signedAmountMinor: 5n,
          currency: 'CREDIT',
        },
        {
          accountId: contra.id,
          signedAmountMinor: -5n,
          currency: 'CREDIT',
        },
      ],
    };
    const first = await services.transactions.create(input);
    expect(first.created).toBeTrue();
    const retry = await services.transactions.create(input);
    expect(retry).toEqual({ transactionId: first.transactionId, created: false });
    await expect(
      services.transactions.create({
        ...input,
        entries: input.entries.map((entry) => ({
          ...entry,
          signedAmountMinor: entry.signedAmountMinor > 0n ? 6n : -6n,
        })),
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      services.transactions.create({
        ...input,
        reference: 'mixed',
        entries: [input.entries[0], { ...input.entries[1], accountId: eurAccount.id }],
      }),
    ).rejects.toThrow();
    const [posted] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, first.transactionId));
    const postedEntries = await db
      .select()
      .from(entries)
      .where(eq(entries.transactionId, first.transactionId));
    expect(posted.assetId).toBe(credit.id);
    expect(postedEntries.every((entry) => entry.assetId === credit.id)).toBeTrue();
    expect((await services.transactions.getById(tenantId, first.transactionId)).assetId).toBe(
      credit.id,
    );
    await expect(
      (async () => {
        await db.update(accounts).set({ assetId: euro.id }).where(eq(accounts.id, debit.id));
      })(),
    ).rejects.toThrow();
  });
});
