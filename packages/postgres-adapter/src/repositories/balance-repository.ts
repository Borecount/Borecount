import { AccountSide, calculateAvailableMinor, parseAccountSide } from '@borecount/core';
import {
  type BalanceApplicationRepository,
  type BalanceAtQuery,
  type BalanceHistoryQuery,
  type BalanceSnapshotEvent,
  balanceHistoryListFilter,
  type HistoricalBalance,
  type LedgerTrialBalanceQuery,
  type PaginatedResult,
  type TrialBalance,
  type TrialBalanceAccount,
} from '@borecount/core/application';
import {
  InvariantViolationError,
  LedgerNotFoundError,
  RepositoryError,
} from '@borecount/core/errors';
import { and, asc, desc, eq, getTableColumns, gte, lte } from 'drizzle-orm';
import type { DbClient } from '../client';
import { exactTimestamp } from '../exact-timestamp';
import { listWhereScope, listWhereSql } from '../list-where';
import { paginateByCursor } from '../paginate-by-cursor';
import * as schema from '../schema';

export class DrizzleBalanceRepository implements BalanceApplicationRepository {
  public constructor(private readonly client: DbClient) {}

  public async getTrialBalance(query: LedgerTrialBalanceQuery): Promise<TrialBalance> {
    return this.client.runTenantTx(query.tenantId, 'get trial balance', async (tx) => {
      const [ledger] = await tx
        .select({ id: schema.ledgers.id })
        .from(schema.ledgers)
        .where(
          and(eq(schema.ledgers.id, query.ledgerId), eq(schema.ledgers.tenantId, query.tenantId)),
        )
        .limit(1);
      if (!ledger) {
        throw new LedgerNotFoundError(query.ledgerId);
      }

      const rows = await tx
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.ledgerId, query.ledgerId),
            eq(schema.accounts.tenantId, query.tenantId),
          ),
        )
        .orderBy(asc(schema.accounts.createdAt), asc(schema.accounts.id));

      let totalDebitsMinor = 0n;
      let totalCreditsMinor = 0n;
      const accounts: TrialBalanceAccount[] = rows.map((row) => {
        const side = parseAccountSide(row.side);
        const isDebit = row.balanceMinor > 0n;
        const balanceSide =
          row.balanceMinor === 0n ? side : isDebit ? AccountSide.DEBIT : AccountSide.CREDIT;
        if (isDebit) {
          totalDebitsMinor += row.balanceMinor;
        } else if (row.balanceMinor < 0n) {
          totalCreditsMinor += -row.balanceMinor;
        }
        return {
          accountId: row.id,
          code: row.code,
          name: row.name,
          normalBalance: side,
          balanceMinor: row.balanceMinor < 0n ? -row.balanceMinor : row.balanceMinor,
          balanceSide,
        };
      });

      if (totalDebitsMinor !== totalCreditsMinor) {
        throw new RepositoryError('trial balance totals mismatch');
      }
      return {
        ledgerId: query.ledgerId,
        accounts,
        totalDebitsMinor,
        totalCreditsMinor,
      };
    });
  }

  public async getAt(query: BalanceAtQuery): Promise<HistoricalBalance> {
    return this.client.runTenantTx(query.tenantId, 'get historical balance', async (tx) => {
      const [account] = await tx
        .select({ side: schema.accounts.side })
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.tenantId, query.tenantId),
            eq(schema.accounts.id, query.accountId),
          ),
        )
        .limit(1);
      if (!account) {
        throw new InvariantViolationError('Unable to get historical balance: account not found');
      }
      const [row] = await tx
        .select()
        .from(schema.balanceSnapshots)
        .where(
          and(
            eq(schema.balanceSnapshots.tenantId, query.tenantId),
            eq(schema.balanceSnapshots.accountId, query.accountId),
            lte(schema.balanceSnapshots.effectiveAt, query.at),
          ),
        )
        .orderBy(desc(schema.balanceSnapshots.effectiveAt), desc(schema.balanceSnapshots.id))
        .limit(1);

      const postedMinor = row?.postedMinor ?? 0n;
      const reservedDeltaMinor = row?.reservedDeltaMinor ?? 0n;
      return {
        tenantId: query.tenantId,
        accountId: query.accountId,
        at: query.at,
        postedMinor,
        reservedDeltaMinor,
        availableMinor: calculateAvailableMinor({
          side: parseAccountSide(account.side),
          balanceMinor: postedMinor,
          reservedDeltaMinor,
        }),
      };
    });
  }

  public async listHistory(
    query: BalanceHistoryQuery,
  ): Promise<PaginatedResult<BalanceSnapshotEvent>> {
    return this.client.runTenantTx(query.tenantId, 'get balance history', async (tx) => {
      const where = listWhereSql(
        getTableColumns(schema.balanceSnapshots),
        balanceHistoryListFilter,
        query.where,
      );
      const page = await paginateByCursor({
        query,
        scope: {
          resource: 'balance-history',
          tenantId: query.tenantId,
          accountId: query.accountId,
          from: query.from.toISOString(),
          to: query.to.toISOString(),
          ...listWhereScope(query.where),
        },
        order: [
          {
            column: schema.balanceSnapshots.effectiveAt,
            key: 'effective_at',
            type: 'timestamp',
            getValue: (
              row: typeof schema.balanceSnapshots.$inferSelect & { cursorEffectiveAt: string },
            ) => row.cursorEffectiveAt,
          },
          {
            column: schema.balanceSnapshots.id,
            key: 'id',
            type: 'uuid',
            getValue: (row) => row.id,
          },
        ],
        selectRows: ({ cursorPredicate, limit, orderBy }) =>
          tx
            .select({
              ...getTableColumns(schema.balanceSnapshots),
              cursorEffectiveAt: exactTimestamp(schema.balanceSnapshots.effectiveAt),
            })
            .from(schema.balanceSnapshots)
            .where(
              and(
                eq(schema.balanceSnapshots.tenantId, query.tenantId),
                eq(schema.balanceSnapshots.accountId, query.accountId),
                gte(schema.balanceSnapshots.effectiveAt, query.from),
                lte(schema.balanceSnapshots.effectiveAt, query.to),
                where,
                cursorPredicate,
              ),
            )
            .orderBy(...orderBy)
            .limit(limit),
      });
      const data = page.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        ledgerId: row.ledgerId,
        accountId: row.accountId,
        eventType: row.eventType as BalanceSnapshotEvent['eventType'],
        sourceId: row.sourceId,
        postedMinor: row.postedMinor,
        reservedDeltaMinor: row.reservedDeltaMinor,
        effectiveAt: row.effectiveAt,
        createdAt: row.createdAt,
      }));
      return { data, nextCursor: page.nextCursor };
    });
  }
}
