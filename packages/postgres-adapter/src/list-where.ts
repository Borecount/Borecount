import {
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
  SQL,
} from 'drizzle-orm';

const compare = (operator: typeof eq, column: AnyColumn | SQL, value: unknown): SQL =>
  column instanceof SQL ? operator(column, value) : operator(column, value);

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
    const column = (columns as Record<string, AnyColumn | SQL>)[field];
    for (const [operator, value] of Object.entries(filter)) {
      switch (operator) {
        case 'eq':
          clauses.push(value === null ? isNull(column) : compare(eq, column, value));
          break;
        case 'ne':
          clauses.push(value === null ? isNotNull(column) : compare(ne, column, value));
          break;
        case 'in':
          clauses.push(
            column instanceof SQL
              ? inArray(column, value as unknown[])
              : inArray(column, value as unknown[]),
          );
          break;
        case 'gt':
          clauses.push(compare(gt, column, value));
          break;
        case 'gte':
          clauses.push(compare(gte, column, value));
          break;
        case 'lt':
          clauses.push(compare(lt, column, value));
          break;
        case 'lte':
          clauses.push(compare(lte, column, value));
          break;
      }
    }
  }
  return and(...clauses);
};

/** Keep existing unfiltered cursor scopes compatible. */
export const listWhereScope = (where: unknown): Record<string, string> => {
  const serialized = serializeListWhere(where);
  return serialized === '{}' ? {} : { where: serialized };
};
