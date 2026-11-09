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

Asset, ledger, API key, and reconciliation matching-rule list routes accept `limit` (default 50, maximum 200), an opaque `cursor`, and endpoint-specific typed `where` filters. They return `{ data, next_cursor }`. Reconciliation run results are available through `GET /v1/reconciliation/runs/{id}/results`.

Tenant clients can discover asset scales with `GET /v1/assets` and `GET /v1/assets/{id}`.
`POST /v1/assets` requires an authenticated `ADMIN` context supplied by the host.
The create body takes `code` and `scale`. Codes are trimmed and uppercased, scales are integers
from 0 through 18, and duplicate codes within a tenant return `409 ASSET_CODE_CONFLICT`.
Clients can reuse the same SERVICE credentials they use for other tenant reads.

Pin compatible Borecount package versions and verify the released OpenAPI before production; see [versioning and publication](../../docs/integration/versioning.md).

## JSON parsing

Registration installs `express.json()` with Express defaults before ledger routes. Like other
application middleware, it also applies to subsequently registered routes. Hosts can pass
`jsonParser: express.json({ limit: '1mb' })` to choose parser settings, or `jsonParser: false` when
they install their own parser before registration. Install the host error handler after routes
and map known parser size errors to the documented 413 response.
