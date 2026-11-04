# Trusted actor authorization for adjustments

Credit and debit adjustments change a ledger balance. The host application owns authentication,
tenant scoping, and authorization for each direction. The route adapters validate and transport the
request; they do not supply authentication, role based access control, or a callback API for host
policy.

## Required policy

- Authenticate every request and resolve its tenant from trusted credentials. Scope every request to
  that tenant; never take tenant identity from the body or infer it from a resource identifier.
- Explicitly authorize the requested `credit` or `debit` direction on every request, including an
  idempotent retry.
- Require the request's opaque `actor_id` claim to exactly equal the host-resolved
  `effectiveActorId`. On mismatch, return `403 FORBIDDEN` without calling an application service;
  do not silently replace or rewrite the submitted actor.
- A service principal may assert an opaque/on-behalf-of actor only when host policy explicitly allows
  that assertion. Keep the authenticating service identity distinct from the effective actor.
- Treat `attributes` as caller supplied, untrusted metadata. They do not prove identity or
  authorization. If verified attribution is needed, the host owns and adds reserved attribution
  fields; reject caller attempts to override those fields and use stable metadata across retries.
- Missing or invalid authentication returns `401`. Unexpected host authorization failures return a
  redacted `500`; do not expose internal details.

The adapter remains responsible for request shape validation. For example, invalid `actor_id` shape
is an adapter `400 INVALID_INPUT`, not an authorization decision. A host guard that inspects the body
should first check it is a record and that actor text is nonblank, using
`isRecord` and `isNonEmptyTrimmed` from the public `@borecount/http/validation-utils` export. Do not
duplicate the adapter's broader body validation in host middleware.

## Fastify wiring

Install authentication before this hook and register the adapter after it. Match the resolved route
template (not the raw URL) so equivalent URLs cannot bypass the guard. Catch host guard failures here
and map them explicitly to the adapter's safe HTTP error payload; do not let them fall through to a
route-specific error handler.

```ts
const adjustmentPaths = new Set([
  '/v1/adjustments/credit',
  '/v1/adjustments/debit',
]);

server.addHook('preValidation', (request, reply, done) => {
  const path = request.routeOptions.url;
  if (request.method !== 'POST' || !path || !adjustmentPaths.has(path)) {
    done();
    return;
  }
  void authorizeAdjustment(request, path).then(
    () => done(),
    (error: unknown) => {
      const { statusCode, ...payload } = toHttpErrorPayload(error);
      reply.code(statusCode).send(payload);
    },
  );
});

registerLedgerAdapter(server, applicationServices);
```

`authorizeAdjustment` is an asynchronous host-owned function. Import `toHttpErrorPayload` from
`@borecount/http/errors`; throw `UnauthorizedError` or `ForbiddenError` from
`@borecount/core/application` for expected failures. Unknown failures are redacted automatically.
The resolved route template is available during `preValidation`, after authentication and body parsing.
Use the callback hook as shown: call `done()` only on success and never after sending a rejection.
The parity fixture verifies that a rejected asynchronous policy cannot continue into a ledger handler.

## Express wiring

Ensure JSON parsing and authentication run first. Mount an exact-path guard before registering the
adapter; call `next()` only after authorization succeeds. Map host errors explicitly to the same
safe status and error shape, and do not forward internal error details.

```ts
app.use(express.json());
app.use(authenticateRequest);
app.post(
  ['/v1/adjustments/credit', '/v1/adjustments/debit'],
  authorizeAdjustmentMiddleware,
);
registerLedgerAdapter(app, applicationServices);
```

The middleware and Fastify hook should enforce the same policy. They must not implement ledger rules,
modify the request actor, or treat caller-controlled `attributes` as verified host attribution.

## Test and demo notes

The shared adapter parity coverage lives in
[`packages/express-routes/src/parity.test.ts`](../../packages/express-routes/src/parity.test.ts).
The executable host fixture carries a principal with `tenantId`, `apiKeyId`, `apiKeyRole`,
`effectiveActorId`, and `allowedDirections`. Tests cover missing authentication/tenant, direction
denial, spoofed actors, malformed claims, attempted tenant overrides, authorized service and delegated
actors, reauthorization after revocation, and redacted host errors. They assert that denied requests
never reach application services and check the exact actor, attributes, and trusted tenant forwarded.

The reference demo is maintained in the separate
[Borecount-demo repository](https://github.com/Borecount/Borecount-demo). Its `finance-demo-operator`
is a simulated demo actor, not an authenticated user identity. The demo host needs its own follow-up
to resolve and authorize its effective actor under this policy; this repository's documentation does
not claim that external host has been changed.

This integration pattern preserves the existing request body contract and stored data shape. It adds
authorization at the host boundary and does not introduce a production callback API or core policy.
