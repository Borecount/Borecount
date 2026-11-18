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

const millisecondPredicate = (column: SQL, operator: string, value: Date): SQL | undefined => {
  const iso = value.toISOString();
  const lower = sql`${iso}::timestamptz`;
  const upper = sql`${`${iso.slice(0, -1)}999Z`}::timestamptz`;
  // Bound the comparison rather than applying a function to the indexed column.
  switch (operator) {
    case 'eq':
      return and(gte(column, lower), lte(column, upper));
    case 'ne':
      return or(lt(column, lower), gt(column, upper));
    case 'gt':
      return gt(column, upper);
    case 'gte':
      return gte(column, lower);
    case 'lt':
      return lt(column, lower);
    case 'lte':
      return lte(column, upper);
  }
};

const exactOperand = (value: unknown): unknown =>
  isExactTimestampFilter(value) ? sql`${value.exactTimestamp}::timestamptz` : value;

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
      if (value instanceof Date) {
        const predicate = millisecondPredicate(column, operator, value);
        if (predicate) clauses.push(predicate);
        continue;
      }
      const operand = exactOperand(value);
      switch (operator) {
        case 'eq':
          clauses.push(value === null ? isNull(column) : eq(column, operand));
          break;
        case 'ne':
          clauses.push(value === null ? isNotNull(column) : ne(column, operand));
          break;
        case 'in': {
          const values = value as unknown[];
          if (values.some((item) => item instanceof Date || isExactTimestampFilter(item))) {
            const matches = or(
              ...values.map((item) =>
                item instanceof Date
                  ? millisecondPredicate(column, 'eq', item)
                  : eq(column, exactOperand(item)),
              ),
            );
            if (matches) clauses.push(matches);
          } else {
            clauses.push(inArray(column, values));
          }
          break;
        }
        case 'gt':
          clauses.push(gt(column, operand));
          break;
        case 'gte':
          clauses.push(gte(column, operand));
          break;
        case 'lt':
          clauses.push(lt(column, operand));
          break;
        case 'lte':
          clauses.push(lte(column, operand));
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
