import { afterAll, expect, it } from 'bun:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { registerLedgerAdapter as registerExpressAdapter } from '@borecount/express-routes';
import { registerLedgerAdapter as registerFastifyAdapter } from '@borecount/fastify-routes';
import type { AssetResponse, PaginatedResponse } from '@borecount/http/contracts';
import {
  assets,
  createApplicationServices,
  createDbClient,
  tenants,
} from '@borecount/postgres-adapter';
import { eq, sql } from 'drizzle-orm';
import express from 'express';
import Fastify from 'fastify';

const databaseUrl =
  process.env.DATABASE_URL_TEST ?? 'postgresql://luxledger:luxledger@127.0.0.1:5433/luxledger_test';
if (!new URL(databaseUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('Expected a dedicated test database');
}

const client = createDbClient({ databaseUrl, max: 1 });
const services = createApplicationServices(client);
const fixtureTenantIds: string[] = [];
afterAll(async () => {
  try {
    for (const tenantId of fixtureTenantIds) {
      await client.runTenantTx(tenantId, 'remove asset HTTP test fixtures', async (tx) => {
        await tx.delete(assets).where(eq(assets.tenantId, tenantId));
        await tx.delete(tenants).where(eq(tenants.id, tenantId));
      });
    }
  } finally {
    await client.sql.end({ timeout: 5 });
  }
});

const createTenant = async (name: string) => {
  const tenantId = await client.runTx('create asset HTTP test tenant', async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ name }).returning({ id: tenants.id });
    return tenant.id;
  });
  fixtureTenantIds.push(tenantId);
  return tenantId;
};

const createAssetAt = (tenantId: string, code: string, timestamp: string) =>
  client.runTenantTx(tenantId, 'seed asset timestamp', async (tx) => {
    await tx
      .insert(assets)
      .values({ tenantId, code, scale: 2, createdAt: sql`${timestamp}::timestamptz` });
  });

it('returns filtered and cursor-paginated asset pages over HTTP in both adapters', async () => {
  const tenantId = await createTenant('HTTP');
  const otherTenantId = await createTenant('Other');
  const millisecond = '2026-01-01T00:00:00.123Z';
  const exactTimestamp = '2026-01-01T00:00:00.123456Z';
  await createAssetAt(tenantId, 'AAA', '2026-01-01T00:00:00.122999Z');
  await createAssetAt(tenantId, 'BBB', exactTimestamp);
  await createAssetAt(tenantId, 'CCC', '2026-01-01T00:00:00.123999Z');
  await createAssetAt(otherTenantId, 'DDD', exactTimestamp);

  const context = { tenantId, apiKeyId: 'integration-test-key', apiKeyRole: 'SERVICE' as const };
  const fastify = Fastify();
  fastify.addHook('onRequest', async (request) => {
    Object.assign(request, context);
  });
  registerFastifyAdapter(fastify, services, { authorizeAdjustment: false });

  const expressApp = express();
  expressApp.use((request, _response, next) => {
    Object.assign(request, context);
    next();
  });
  registerExpressAdapter(expressApp, services, { authorizeAdjustment: false });
  const server = expressApp.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const requests = [
      async (path: string) => {
        const response = await fastify.inject({ method: 'GET', url: path });
        return {
          status: response.statusCode,
          body: response.json<PaginatedResponse<AssetResponse>>(),
        };
      },
      async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        return {
          status: response.status,
          body: (await response.json()) as PaginatedResponse<AssetResponse>,
        };
      },
    ];
    const pathFor = (timestamp: string, cursor?: string) => {
      const params = new URLSearchParams({
        limit: '1',
        where: JSON.stringify({ created_at: { eq: timestamp } }),
      });
      if (cursor) params.set('cursor', cursor);
      return `/v1/assets?${params}`;
    };
    for (const request of requests) {
      const first = await request(pathFor(millisecond));
      expect(first.status).toBe(200);
      expect(first.body.data.map(({ code, created_at }) => [code, created_at])).toEqual([
        ['BBB', millisecond],
      ]);
      const cursor = first.body.next_cursor;
      if (!cursor) throw new Error('Expected a cursor for the filtered page');

      const second = await request(pathFor(millisecond, cursor));
      expect(second.status).toBe(200);
      expect(second.body.data.map((asset) => asset.code)).toEqual(['CCC']);
      expect(second.body.next_cursor).toBeNull();

      const exact = await request(pathFor(exactTimestamp));
      expect(exact.status).toBe(200);
      expect(exact.body.data.map((asset) => asset.code)).toEqual(['BBB']);
      expect(exact.body.next_cursor).toBeNull();
      expect((await request(pathFor(exactTimestamp, cursor))).status).toBe(400);
    }
  } finally {
    await Promise.all([
      fastify.close(),
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    ]);
  }
});
