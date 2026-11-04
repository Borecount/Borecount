# @borecount/fastify-routes

Fastify route registration package for Borecount HTTP routes.

## Registering the adapter

```ts
import { registerLedgerAdapter } from '@borecount/fastify-routes';

registerLedgerAdapter(server, applicationServices, {
  requireAdjustmentAuthorization: true,
  authorizeAdjustment: async ({ request, direction, tenantId, apiKeyId, apiKeyRole, body }) => {
    const actorId = await resolveEffectiveActor({
      principal: request.authenticatedPrincipal,
      direction,
      tenantId,
      apiKeyId,
      apiKeyRole,
      claimedActorId: body.actor_id,
    });
    return { actorId };
  },
});
```

`server` must be a `FastifyInstance` that already has request auth context decorators used by the app (`tenantId`, `apiKeyId`, `apiKeyRole`).

This package reads no environment variables. Authentication, JWT, rate limiting, bootstrap, `PORT`, `.env` loading, and graceful shutdown are host responsibilities.

## Expected dependencies

`registerLedgerAdapter` expects `ApplicationServices` from `@borecount/core/application`.

## Supported route families

The adapter registers these route families:

- `ledgers` (`/v1/ledgers`, trial balance, create transaction)
- `accounts` (`/v1/accounts`)
- `transactions` (`/v1/transactions`)
- `entries` (`/v1/entries`)
- `admin api keys` (`/v1/admin/api-keys`)

The complete and versioned route surface, including bulk posting, reversal/correction, historical balances, holds, and reconciliation, is defined by [`@borecount/http` OpenAPI](../http/openapi/openapi.yaml). Hosts must register authentication before these routes and keep business logic in application services.

Ledger, API key, and reconciliation matching-rule list routes accept `limit` (default 50, maximum 200), an opaque `cursor`, and endpoint-specific typed `where` filters. They return `{ data, next_cursor }`. Reconciliation run results are available through `GET /v1/reconciliation/runs/{id}/results`.

Pin compatible Borecount package versions and verify the released OpenAPI before production; see [versioning and publication](../../docs/integration/versioning.md).

The third argument is optional `LedgerAdapterOptions`. When supplied, `authorizeAdjustment` runs after body validation and auth-context checks for every credit/debit request, including retries. The host must return the trusted effective actor; the adapter requires it to exactly match `body.actor_id` before calling a service. Set `requireAdjustmentAuthorization: true` to fail registration synchronously if the callback is missing or invalid; this is recommended for new host installations. The flag defaults to `false` for compatibility, so omission does not authorize direction or verify the actor claim. See the [trusted actor integration pattern](../../docs/integration/adjustment-authorization.md).
