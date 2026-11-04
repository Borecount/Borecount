# Adjustment authorization

The host owns authentication, tenant scoping, and authorization for credit and debit adjustments.
Both route adapters accept an optional `authorizeAdjustment` callback for host policy. Core and HTTP
define no authentication or RBAC policy.

## Callback behavior

The host must authenticate every request and populate `tenantId`, `apiKeyId`, and `apiKeyRole` before
the adapter handler runs. When configured, the adapter validates the body and checks those
context fields first, then awaits `authorizeAdjustment` on every request, including idempotent retries.
The callback receives the framework request, direction, trusted request context, and validated body
as `Readonly<CreateAdjustmentRequest>`. Do not mutate the request or body in the callback.

Return the trusted effective actor as `{ actorId }`. The adapter requires an exact match with the
body's opaque `actor_id`; a missing, empty, or mismatched runtime result returns `403 FORBIDDEN`, and
the application service is not called. The adapter does not rewrite the body actor. Throw
`UnauthorizedError` or `ForbiddenError` for expected host denials; unexpected callback errors are
redacted as `500 INTERNAL_ERROR`.

The callback is optional for compatibility with existing trusted service callers. If omitted, the
adapter performs no host authorization or actor verification beyond its normal request validation
and authentication-context presence check. Only omit it when the authenticated caller is trusted to
assert adjustment actors.

## Example

```ts
import { registerLedgerAdapter } from '@borecount/fastify-routes';
import { ForbiddenError } from '@borecount/core/application';

registerLedgerAdapter(server, applicationServices, {
  authorizeAdjustment: async ({ request, direction, tenantId, apiKeyId, apiKeyRole, body }) => {
    const principal = request.authenticatedPrincipal;
    if (!principal || principal.tenantId !== tenantId || principal.apiKeyId !== apiKeyId) {
      throw new ForbiddenError('Adjustment is not authorized');
    }
    if (!principal.allowedDirections.includes(direction)) {
      throw new ForbiddenError('Adjustment is not authorized');
    }

    // Resolve the effective actor under host policy, including any delegation rules.
    const actorId = await resolveEffectiveActor(principal, body.actor_id, apiKeyRole);
    if (actorId !== body.actor_id) {
      throw new ForbiddenError('Adjustment is not authorized');
    }
    return { actorId };
  },
});
```

The example's `authenticatedPrincipal` and `resolveEffectiveActor` belong to the host. For Express,
pass the same option as the third argument to `registerLedgerAdapter(app, applicationServices,
options)`; the callback request is the adapter's `RequestWithContext`. Authentication middleware and
JSON parsing must run before adapter routes.

Keep the authenticating service identity distinct from the effective actor. A service principal may
assert an opaque/on-behalf-of actor only when host policy explicitly permits it. The adapter preserves the validated command and audit attributes. `attributes` remain caller supplied, untrusted metadata:
they do not establish identity, the callback does not inject or reserve attribution fields, and the
host must reject forged reserved claims if its own policy uses such fields. Keep metadata stable on
retries.

Invalid actor shape returns `400 INVALID_INPUT` before the callback runs. The callback receives a
validated body and should focus on host authorization without duplicating schema validation.

The public callback types are available from `@borecount/http/route-core`:
`AdjustmentAuthorizationContext<Request>`, `AdjustmentAuthorizationHook<Request>`, and
`LedgerAdapterOptions<Request>`. Each framework adapter also exports its framework-bound
`LedgerAdapterOptions` type.

## Verification and demo

Shared adapter parity coverage is in
[`packages/express-routes/src/parity.test.ts`](../../packages/express-routes/src/parity.test.ts).
It exercises authenticated host principals, tenant/API-key context, allowed directions, actor
matching, retries, and denied requests without service calls.

The reference demo is maintained in the separate
[Borecount-demo repository](https://github.com/Borecount/Borecount-demo). Its `finance-demo-operator`
is a simulated demo actor, not an authenticated user identity. The demo host requires a separate
follow-up to configure actor authorization; this repository does not claim that the external host
has been updated.

This callback adds host policy at the adapter boundary. It does not add core RBAC, change the request
body contract, modify stored data, or automatically resolve an actor when the host has not configured
the callback.
