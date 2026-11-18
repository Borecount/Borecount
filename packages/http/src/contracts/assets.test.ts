import { expect, test } from 'bun:test';
import { parseAssetListQuery } from './assets';

const queryWithWhere = (where: object): string =>
  `/v1/assets?${new URLSearchParams({ where: JSON.stringify(where) })}`;

test('asset list parses paging and typed filter operands', () => {
  expect(parseAssetListQuery('/v1/assets')).toEqual({
    limit: 50,
    cursor: undefined,
    where: undefined,
  });
  const createdAt = '2026-01-01T00:00:00Z';
  const url = queryWithWhere({
    code: { in: ['USD', 'EUR'] },
    scale: { gte: 2, lt: 18 },
    created_at: { gte: createdAt },
  });
  expect(parseAssetListQuery(`${url}&limit=2&cursor=next`)).toEqual({
    limit: 2,
    cursor: 'next',
    where: {
      code: { in: ['USD', 'EUR'] },
      scale: { gte: 2, lt: 18 },
      createdAt: { gte: new Date(createdAt) },
    },
  });
});

test('asset list rejects ambiguous query parameters and unsupported filter values', () => {
  for (const query of ['limit=0', 'limit=201', 'limit=1&limit=2', 'cursor=', 'tenant_id=other']) {
    expect(parseAssetListQuery(`/v1/assets?${query}`)).toBeNull();
  }
  for (const scale of ['2', -1, 19, 2.5]) {
    expect(parseAssetListQuery(queryWithWhere({ scale: { eq: scale } }))).toBeNull();
  }
  expect(parseAssetListQuery(queryWithWhere({ tenant_id: { eq: 'other' } }))).toBeNull();
});
