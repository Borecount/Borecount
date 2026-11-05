import type { UnknownRecord } from '@borecount/core/base';

import { isUuid } from '@borecount/core/base';

export { isUuid, UUID_PATTERN } from '@borecount/core/base';

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseUuidParam = <T extends string>(
  value: unknown,
  key: T,
): Record<T, string> | null => {
  if (!isUuid(value)) {
    return null;
  }
  return { [key]: value } as Record<T, string>;
};
