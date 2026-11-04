# @borecount/express-routes

Express route registration package for Borecount HTTP routes, aligned with `@borecount/fastify-routes`.

## Composition API

```ts
import express from 'express';
import { registerLedgerAdapter } from '@borecount/express-routes';

const app = express();
registerLedgerAdapter(app, applicationServices, {
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

## Expected dependencies

`registerLedgerAdapter` expects `ApplicationServices` from `@borecount/core/application`.

## Request context requirements

Routes require auth context to be pre-populated on the request:

- `tenantId`
- `apiKeyId`
- `apiKeyRole`

The hosting app must add auth middleware before adapter registration.

This package reads no environment variables. Authentication, JWT, rate limiting, bootstrap, `PORT`, `.env` loading, and graceful shutdown are host responsibilities.

## Known framework differences and mitigations

- Validation:
  Express has no built-in JSON schema validation. The adapter applies explicit transport-level checks and maps failures to `400 INVALID_INPUT`.
- Error serialization:
  Express errors are translated through the same domain-error shape (`{ error, message }`) used by Fastify.
- Middleware ordering:
  The host must register authentication middleware before adapter routes.
- JSON parsing:
  Route registration ensures JSON middleware exists for request body parsing.

The complete and versioned route surface is defined by [`@borecount/http` OpenAPI](../http/openapi/openapi.yaml). See the repository [integration guide](../../docs/integration/README.md) before composing the adapter in a host application.

Pass host policy in the third argument, `LedgerAdapterOptions`. `authorizeAdjustment` runs after body validation and auth-context checks for every credit/debit request, including retries. The host must return the trusted effective actor; the adapter requires it to exactly match `body.actor_id` before calling a service. For an explicitly trusted service integration, pass `{ authorizeAdjustment: false }`; schema validation and auth-context checks still apply, but the adapter does not authorize direction or verify the actor claim. Missing, `undefined`, `null`, or another invalid option value fails registration synchronously. Existing hosts must add a callback or explicitly opt out before upgrading. See the [trusted actor integration pattern](../../docs/integration/adjustment-authorization.md).

Ledger, API key, and reconciliation matching-rule list routes accept `limit` (default 50, maximum 200), an opaque `cursor`, and endpoint-specific typed `where` filters. They return `{ data, next_cursor }`. Reconciliation run results are available through `GET /v1/reconciliation/runs/{id}/results`.

Pin compatible Borecount package versions and verify the released OpenAPI before production; see [versioning and publication](../../docs/integration/versioning.md).
