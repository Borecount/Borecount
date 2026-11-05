import { expect, test } from 'bun:test';
import { RateLimitExceededError } from '@borecount/core/errors';
import * as publicApi from '../index';

test('public API includes shared HTTP contracts and primitives', () => {
  const keys = Object.keys(publicApi);
  expect(keys).toContain('createTransactionRequestSchema');
  expect(keys).toContain('createAccountBodySchema');
  expect(keys).toContain('createApiKeyBodySchema');
  expect(keys).toContain('createLedgerBodySchema');
  expect(keys).toContain('entriesPageResponseSchema');
  expect(keys).toContain('holdsPageResponseSchema');
  expect(keys).toContain('toHoldSummaryResponse');
  expect(keys).toContain('holdFilterFields');
  expect(keys).toContain('ApiKeyRole');
  expect(keys).toContain('mapDomainErrorToHttp');
  expect(keys).not.toContain('RateLimitExceededError');
  expect(keys).toContain('toHttpErrorPayload');
  expect(keys).toContain('rateLimitExceededResponseSchema');
});

test('host resource contracts are available through the root and errors entry points', async () => {
  const errors = await import('../errors');
  const error = new RateLimitExceededError(5);
  const { statusCode, headers, ...body } = errors.toHttpErrorPayload(error);
  const rate: publicApi.RateLimitExceededResponse = {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Rate limit exceeded',
    retry_after_seconds: 5,
  };
  expect(statusCode).toBe(429);
  expect(headers).toEqual({ 'Retry-After': '5' });
  expect(body).toEqual(rate);
  expect(errors.rateLimitExceededResponseSchema).toBe(publicApi.rateLimitExceededResponseSchema);
});

// Compile the host extension through both supported public entry points.
test('public callback types support framework-neutral host context', () => {
  const options: publicApi.LedgerAdapterOptions<{ principal: string }> = {
    authorizeAdjustment: ({ request }) => ({ actorId: request.principal }),
  };
  const subpathOptions: import('../route-core').LedgerAdapterOptions<{ principal: string }> =
    options;
  expect(subpathOptions.authorizeAdjustment).toBe(options.authorizeAdjustment);
});

test('callback audit metadata is recursively readonly at the public type boundary', () => {
  const options: publicApi.LedgerAdapterOptions<object> = {
    authorizeAdjustment: ({ body }) => {
      if (body.attributes) {
        // @ts-expect-error Audit object keys must remain readonly in host callbacks.
        body.attributes.ticket = 'changed';
        const nested = body.attributes.nested;
        if (nested && typeof nested === 'object' && 'label' in nested) {
          // @ts-expect-error Nested audit properties must also remain readonly.
          nested.label = 'changed';
        }
      }
      return { actorId: body.actor_id };
    },
  };
  expect(typeof options.authorizeAdjustment).toBe('function');
});
