import {
  type HoldApplicationRepository,
  type HoldCapture,
  type HoldCapturesQuery,
  type HoldCreditAllocation,
  type HoldCreditAllocationsQuery,
  type HoldEntriesQuery,
  type HoldEntry,
  type HoldListQuery,
  type HoldSummary,
  holdCaptureListFilter,
  holdCreditAllocationListFilter,
  holdEntryListFilter,
  holdListFilter,
} from '@borecount/core/application';
import { HoldNotFoundError, InvariantViolationError } from '@borecount/core/errors';
import { and, eq, exists, inArray, not, type SQL, sql } from 'drizzle-orm';
import type { DbClient, DrizzleDatabase } from '../client';
import { listWhereScope, listWhereSql } from '../list-where';
import { paginateByCursor } from '../paginate-by-cursor';
import * as schema from '../schema';

const summaryColumns = {
  id: schema.holds.id,
  ledgerId: schema.holds.ledgerId,
  reference: schema.holds.reference,
  currency: schema.holds.currency,
  description: schema.holds.description,
  state: schema.holds.state,
  originalAmountMinor: schema.holds.originalAmountMinor,
  remainingAmountMinor: schema.holds.remainingAmountMinor,
  createdAt: schema.holds.createdAt,
  appliedAt: schema.holds.appliedAt,
  voidedAt: schema.holds.voidedAt,
};
const entryColumns = {
  id: schema.holdEntries.id,
  accountId: schema.holdEntries.accountId,
  signedAmountMinor: schema.holdEntries.signedAmountMinor,
  currency: schema.holdEntries.currency,
  createdAt: schema.holdEntries.createdAt,
};
const allocationColumns = {
  id: schema.creditGrantHoldAllocations.id,
  holdEntryId: schema.creditGrantHoldAllocations.holdEntryId,
  accountId: schema.creditGrantHoldAllocations.accountId,
  grantId: schema.creditGrantHoldAllocations.grantId,
  amountMinor: schema.creditGrantHoldAllocations.amountMinor,
  createdAt: schema.creditGrantHoldAllocations.createdAt,
};
// Sum only debit entries: summing both sides of a balanced posting would yield zero.
// Keep outer references explicitly qualified: single-table Drizzle selections otherwise
// strip column table names, allowing inner entry columns to shadow the correlated IDs.
const captureAmount = sql<bigint>`(select coalesce(sum(e.signed_amount_minor), 0)
  from ${schema.entries} e where e.tenant_id = ${schema.transactions}.${sql.identifier('tenant_id')}
  and e.transaction_id = ${schema.transactions}.${sql.identifier('id')} and e.signed_amount_minor > 0)`.mapWith(
  BigInt,
);
const captureColumns = {
  id: schema.transactions.id,
  reference: schema.transactions.reference,
  amountMinor: captureAmount,
  currency: schema.transactions.currency,
  createdAt: schema.transactions.createdAt,
};

/** Read projections only; financial transitions remain in DrizzleHoldRepository. */
export class DrizzleHoldReadRepository
  implements
    Pick<
      HoldApplicationRepository,
      'findById' | 'list' | 'listEntries' | 'listCaptures' | 'listCreditAllocations'
    >
{
  public constructor(private readonly readClient: DbClient) {}

  public async findById(tenantId: string, holdId: string) {
    return this.readClient.runTenantTx(tenantId, 'find hold', async (tx) => {
      const [row] = await tx
        .select(summaryColumns)
        .from(schema.holds)
        .where(and(eq(schema.holds.tenantId, tenantId), eq(schema.holds.id, holdId)))
        .limit(1);
      return row ?? null;
    });
  }

  public async list(query: HoldListQuery) {
    return this.readClient.runTenantTx(query.tenantId, 'list holds', async (tx) => {
      const { accountId, ...scalarWhere } = query.where ?? {};
      if (
        accountId &&
        Object.keys(accountId).some((operator) => !['eq', 'ne', 'in'].includes(operator))
      ) {
        throw new InvariantViolationError('Invalid account membership filter');
      }
      const scalar = listWhereSql(
        { ...summaryColumns, accountId: schema.holdEntries.accountId },
        holdListFilter,
        scalarWhere,
      );
      const membership = (predicate: ReturnType<typeof eq>) =>
        exists(
          tx
            .select({ id: schema.holdEntries.id })
            .from(schema.holdEntries)
            .where(
              and(
                eq(schema.holdEntries.tenantId, query.tenantId),
                eq(schema.holdEntries.holdId, schema.holds.id),
                predicate,
              ),
            ),
        );
      const accountPredicates: SQL[] = [];
      if (accountId?.eq !== undefined)
        accountPredicates.push(membership(eq(schema.holdEntries.accountId, accountId.eq)));
      if (accountId?.ne !== undefined)
        accountPredicates.push(not(membership(eq(schema.holdEntries.accountId, accountId.ne))));
      if (accountId?.in !== undefined)
        accountPredicates.push(
          membership(inArray(schema.holdEntries.accountId, [...accountId.in])),
        );
      const page = await paginateByCursor<HoldSummary>({
        query,
        scope: { resource: 'holds', tenantId: query.tenantId, ...listWhereScope(query.where) },
        order: [
          {
            column: schema.holds.id,
            key: 'id',
            type: 'uuid',
            getValue: (row: { id: string }) => row.id,
          },
        ],
        selectRows: ({ cursorPredicate, limit, orderBy }) =>
          tx
            .select(summaryColumns)
            .from(schema.holds)
            .where(
              and(
                eq(schema.holds.tenantId, query.tenantId),
                scalar,
                ...accountPredicates,
                cursorPredicate,
              ),
            )
            .orderBy(...orderBy)
            .limit(limit),
      });
      return { data: page.rows, nextCursor: page.nextCursor };
    });
  }

  public async listEntries(query: HoldEntriesQuery) {
    return this.readClient.runTenantTx(query.tenantId, 'list hold entries', async (tx) => {
      await this.assertParent(tx, query.tenantId, query.holdId);
      const where = listWhereSql(entryColumns, holdEntryListFilter, query.where);
      const page = await paginateByCursor<HoldEntry>({
        query,
        scope: {
          resource: 'hold-entries',
          tenantId: query.tenantId,
          holdId: query.holdId,
          ...listWhereScope(query.where),
        },
        order: [
          {
            column: schema.holdEntries.id,
            key: 'id',
            type: 'uuid',
            getValue: (row: { id: string }) => row.id,
          },
        ],
        selectRows: ({ cursorPredicate, limit, orderBy }) =>
          tx
            .select(entryColumns)
            .from(schema.holdEntries)
            .where(
              and(
                eq(schema.holdEntries.tenantId, query.tenantId),
                eq(schema.holdEntries.holdId, query.holdId),
                where,
                cursorPredicate,
              ),
            )
            .orderBy(...orderBy)
            .limit(limit),
      });
      return { data: page.rows, nextCursor: page.nextCursor };
    });
  }

  public async listCaptures(query: HoldCapturesQuery) {
    return this.readClient.runTenantTx(query.tenantId, 'list hold captures', async (tx) => {
      await this.assertParent(tx, query.tenantId, query.holdId);
      const where = listWhereSql(captureColumns, holdCaptureListFilter, query.where);
      const page = await paginateByCursor<HoldCapture>({
        query,
        scope: {
          resource: 'hold-captures',
          tenantId: query.tenantId,
          holdId: query.holdId,
          ...listWhereScope(query.where),
        },
        order: [
          {
            column: schema.transactions.id,
            key: 'id',
            type: 'uuid',
            getValue: (row: { id: string }) => row.id,
          },
        ],
        selectRows: ({ cursorPredicate, limit, orderBy }) =>
          tx
            .select(captureColumns)
            .from(schema.transactions)
            .where(
              and(
                eq(schema.transactions.tenantId, query.tenantId),
                eq(schema.transactions.holdId, query.holdId),
                where,
                cursorPredicate,
              ),
            )
            .orderBy(...orderBy)
            .limit(limit),
      });
      return { data: page.rows, nextCursor: page.nextCursor };
    });
  }

  public async listCreditAllocations(query: HoldCreditAllocationsQuery) {
    return this.readClient.runTenantTx(
      query.tenantId,
      'list hold credit allocations',
      async (tx) => {
        await this.assertParent(tx, query.tenantId, query.holdId);
        const where = listWhereSql(allocationColumns, holdCreditAllocationListFilter, query.where);
        const page = await paginateByCursor<HoldCreditAllocation>({
          query,
          scope: {
            resource: 'hold-credit-allocations',
            tenantId: query.tenantId,
            holdId: query.holdId,
            ...listWhereScope(query.where),
          },
          order: [
            {
              column: schema.creditGrantHoldAllocations.id,
              key: 'id',
              type: 'uuid',
              getValue: (row: { id: string }) => row.id,
            },
          ],
          selectRows: ({ cursorPredicate, limit, orderBy }) =>
            tx
              .select(allocationColumns)
              .from(schema.creditGrantHoldAllocations)
              .innerJoin(
                schema.holdEntries,
                and(
                  eq(schema.holdEntries.id, schema.creditGrantHoldAllocations.holdEntryId),
                  eq(schema.holdEntries.tenantId, schema.creditGrantHoldAllocations.tenantId),
                ),
              )
              .where(
                and(
                  eq(schema.creditGrantHoldAllocations.tenantId, query.tenantId),
                  eq(schema.holdEntries.tenantId, query.tenantId),
                  eq(schema.holdEntries.holdId, query.holdId),
                  where,
                  cursorPredicate,
                ),
              )
              .orderBy(...orderBy)
              .limit(limit),
        });
        return { data: page.rows, nextCursor: page.nextCursor };
      },
    );
  }

  private async assertParent(tx: DrizzleDatabase, tenantId: string, holdId: string): Promise<void> {
    const [parent] = await tx
      .select({ id: schema.holds.id })
      .from(schema.holds)
      .where(and(eq(schema.holds.tenantId, tenantId), eq(schema.holds.id, holdId)))
      .limit(1);
    if (!parent) throw new HoldNotFoundError(holdId);
  }
}
