import {
  isExactTimestampFilter,
  type ListFilterPolicy,
  serializeListWhere,
  validateListWhere,
  type WhereFor,
} from '@borecount/core/application';
import { InvariantViolationError } from '@borecount/core/errors';
import {
  type AnyColumn,
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

const comparisonOperands = (column: SQL, value: unknown): [SQL, unknown] => {
  if (value instanceof Date) {
    return [sql`date_trunc('milliseconds', ${column})`, sql`${value.toISOString()}::timestamptz`];
  }
  if (isExactTimestampFilter(value)) {
    return [column, sql`${value.exactTimestamp}::timestamptz`];
  }
  return [column, value];
};

/** Column maps come from the existing schema; operation policy supplies exclusions. */
export const listWhereSql = <Policy extends ListFilterPolicy>(
  columns: Record<keyof WhereFor<Policy>, AnyColumn | SQL>,
  policy: Policy,
  where: WhereFor<NoInfer<Policy>> | undefined,
): SQL | undefined => {
  validateListWhere(policy, where);
  const clauses: SQL[] = [];
  for (const [field, filter] of Object.entries(
    (where ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    if (!Object.hasOwn(columns, field)) {
      throw new InvariantViolationError(`Invalid where field: ${field}`);
    }
    // Keep the runtime column encoder; Drizzle overloads cannot accept the union type.
    const column = (columns as Record<string, AnyColumn | SQL>)[field] as SQL;
    for (const [operator, value] of Object.entries(filter)) {
      const operands = comparisonOperands(column, value);
      switch (operator) {
        case 'eq':
          clauses.push(value === null ? isNull(column) : eq(...operands));
          break;
        case 'ne':
          clauses.push(value === null ? isNotNull(column) : ne(...operands));
          break;
        case 'in': {
          const values = value as unknown[];
          if (values.some((item) => item instanceof Date || isExactTimestampFilter(item))) {
            const matches = or(...values.map((item) => eq(...comparisonOperands(column, item))));
            if (matches) clauses.push(matches);
          } else {
            clauses.push(inArray(column, values));
          }
          break;
        }
        case 'gt':
          clauses.push(gt(...operands));
          break;
        case 'gte':
          clauses.push(gte(...operands));
          break;
        case 'lt':
          clauses.push(lt(...operands));
          break;
        case 'lte':
          clauses.push(lte(...operands));
          break;
      }
    }
  }
  return and(...clauses);
};

/** Bind every cursor to the normalized filter, including an empty filter. */
export const listWhereScope = (where: unknown): Record<string, string> => {
  return { where: serializeListWhere(where) };
};
