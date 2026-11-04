# Adjustment authorization

The host owns authentication, tenant scoping, and authorization for credit and debit adjustments.
Both route adapters require an explicit `authorizeAdjustment` option. Core and HTTP define no
authentication or RBAC policy.

## Callback behavior

The host must authenticate every request and populate `tenantId`, `apiKeyId`, and `apiKeyRole` before
the adapter handler runs. When configured, the adapter validates the body and checks those context
fields first, then awaits `authorizeAdjustment` on every request, including idempotent retries. The
callback receives the framework request, direction, trusted request context, and a detached snapshot
of the validated body. Its type is recursively readonly; at runtime it is a separate `structuredClone`
copy, not a frozen object. The adapter also keeps a separate command snapshot for the service, so
mutations through `context.body` or `request.body` cannot alter the posted command or its attributes.
Still, do not mutate the callback body or raw request body.

Return the trusted effective actor as `{ actorId }`. The adapter requires an exact match with the
body's opaque `actor_id`; a missing, empty, or mismatched runtime result returns `403 FORBIDDEN`, and
the application service is not called. The adapter does not rewrite the body actor. Throw
`UnauthorizedError` or `ForbiddenError` for expected host denials; unexpected callback errors are
redacted as `500 INTERNAL_ERROR`.

Pass the host policy function as `authorizeAdjustment`. To explicitly bypass operation authorization
and actor verification for a trusted service integration, pass `{ authorizeAdjustment: false }`.
Schema validation and authentication-context checks still apply in that mode. Missing, `undefined`,
`null`, or any other invalid option value throws a clear `Error` synchronously during registration.
Existing hosts must add a callback or explicitly opt out with `false` before upgrading.

## Example

```ts
import { registerLedgerAdapter } from '@borecount/fastify-routes';
import { ForbiddenError } from '@borecount/core/application';
import type { FastifyInstance } from 'fastify';

declare const server: FastifyInstance;

type HostPrincipal = {
  tenantId: string;
  apiKeyId: string;
  allowedDirections: readonly ('credit' | 'debit')[];
  effectiveActorId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedPrincipal?: HostPrincipal;
  }
}

server.decorateRequest('authenticatedPrincipal');
// Authentication must populate the principal for each request. Typing and decoration do not
// authenticate a request.

registerLedgerAdapter(server, applicationServices, {
  authorizeAdjustment: async ({ request, direction, tenantId, apiKeyId, body }) => {
    const principal = request.authenticatedPrincipal;
    if (!principal || principal.tenantId !== tenantId || principal.apiKeyId !== apiKeyId) {
      throw new ForbiddenError('Adjustment is not authorized');
    }
    if (!principal.allowedDirections.includes(direction)) {
      throw new ForbiddenError('Adjustment is not authorized');
    }

    // Delegation and on-behalf-of rules remain host policy.
    const actorId = principal.effectiveActorId;
    if (actorId !== body.actor_id) {
      throw new ForbiddenError('Adjustment is not authorized');
    }
    return { actorId };
  },
});
```

For an explicitly trusted service caller that owns actor authorization, opt out with:

```ts
registerLedgerAdapter(server, applicationServices, { authorizeAdjustment: false });
```

`HostPrincipal` and its effective actor resolution belong to the host. A host that supports delegation
must resolve the effective actor under its own policy. For Express, pass the same options as the third
argument to `registerLedgerAdapter(app, applicationServices, options)`; the callback request is the
adapter's `RequestWithContext`. Authentication middleware and JSON parsing must run before adapter
routes.

Keep the authenticating service identity distinct from the effective actor. A service principal may
assert an opaque/on-behalf-of actor only when host policy explicitly permits it. The adapter preserves the validated command and audit attributes. `attributes` remain caller supplied, untrusted metadata:
they do not establish identity, the callback does not inject or reserve attribution fields, and the
host must reject forged reserved claims if its own policy uses such fields. Keep metadata stable on
retries.

Invalid actor shape returns `400 INVALID_INPUT` before the callback runs. The callback receives a
validated body and should focus on host authorization without duplicating schema validation.

The public callback types are available from `@borecount/http/route-core`:
`AdjustmentAuthorizationContext<Request>`, `AdjustmentAuthorizationHook<Request>`, and
`LedgerAdapterOptions<Request>`. The callback body uses a private recursively readonly type mapping;
there is no separately exported `DeepReadonly` type. Each framework adapter also exports its
framework-bound `LedgerAdapterOptions` type.

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
