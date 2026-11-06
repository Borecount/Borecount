# @borecount/http

HTTP mapping helpers for `@borecount/core` domain/application errors.

## Boundaries

- Owns transport contracts and route-level reusable error response specs.
- Maps domain/application errors and `RateLimitExceededError` from `@borecount/core/errors` to transport-safe responses.
- Recognizes validated `Symbol.for` brands shared by core error classes across package copies; raw database/unknown errors produce non-leaking `500 INTERNAL_ERROR` responses.
- Contains no HTTP server runtime code and no persistence code.
- Reads no environment variables; JWT, rate limiting, port, and lifecycle configuration belong to the host application.

## Forbidden dependencies
- No framework runtime deps (for example: `fastify`, `express`, `nestjs`).
- No adapter/runtime deps (for example: `drizzle-orm`, `postgres`).
- Keep dependency direction: can depend on `@borecount/core`, never on `apps/*`.

## Public API
- `@borecount/http`:
  - `toHttpErrorPayload`
  - `errorResponseSchema`
  - `defaultErrorResponses`
  - `rateLimitExceededResponseSchema`
  - `RateLimitExceededResponse` type
  - `readWhereParameter`, typed list-filter field maps, and URL-encoded JSON schema helpers
  - `ErrorResponse` type
- `@borecount/http/errors`: schema and response contracts
- `@borecount/http/errors`: error mapping
- `@borecount/http/route-specs`: default route error response specs
- `@borecount/http/route-core`: `AdjustmentAuthorizationContext<Request>`,
  `AdjustmentAuthorizationHook<Request>`, and `LedgerAdapterOptions<Request>` for host-owned
  adjustment authorization callbacks

`LedgerAdapterOptions` requires the `authorizeAdjustment` property: provide the callback, or use
`false` to explicitly bypass host authorization and actor verification. The callback runs after
validation and auth-context checks; `false` preserves both checks. Missing, `undefined`, `null`, or
another invalid value makes adapter registration fail synchronously. The registration options
argument itself is optional only so the adapter can report that error. The framework adapters also
export `LedgerAdapterOptions` bound to their request type. See the
[trusted actor integration guide](../../docs/integration/adjustment-authorization.md) for callback
timing, detached body snapshots, result matching, and the explicit trusted-service opt-out.

## Usage

```ts
import { defaultErrorResponses, toHttpErrorPayload } from '@borecount/http';

const { statusCode, headers, body } = toHttpErrorPayload(error);
if (headers) reply.headers(headers);
reply.code(statusCode).send(body);
route.schema.response = { ...defaultErrorResponses };
```

```ts
import { errorResponseSchema } from '@borecount/http/errors';
```

## Host resource protection responses

The canonical contract documents host-generated `429` responses for `/v1/*` operations and `413`
responses for POST operations. All ordinary errors, including `413`, use `errorResponseSchema`.
Only `429` adds a required `retry_after_seconds` field through `rateLimitExceededResponseSchema`.
These schemas and the mapper are available from both `@borecount/http` and
`@borecount/http/errors`; error classes come from `@borecount/core/errors`; `defaultErrorResponses` includes both statuses. They do not install a
limiter, configure body parsing, or change application services.

The host limiter throws the shared resource-limit error when it denies admission:

```ts
import { RateLimitExceededError } from '@borecount/core/errors';

throw new RateLimitExceededError(retryAfterSeconds);
```

The delay must be a positive safe integer; round the remaining window up and clamp it to at least
one second before constructing the error. `Number.MAX_SAFE_INTEGER` is a numeric representation
bound, not an operational recommendation: hosts must choose a practical maximum delay supported
by their clients (for example, no longer than their configured limiter window). The mapper produces the existing MVP JSON shape and
matching `Retry-After` header. Framework adapters use it for errors caught inside their route handlers.
Errors thrown earlier by host hooks or middleware need the same mapping in the host's global error
handler; adapter registration does not install or replace that handler.

In the host's existing Fastify error handler, after its framework-specific validation handling:

```ts
import { toHttpErrorPayload } from '@borecount/http';

const { statusCode, headers, body } = toHttpErrorPayload(error);
if (headers) reply.headers(headers);
reply.code(statusCode).send(body);
```

Express hosts use `res.set(headers)` when headers are present and
`res.status(statusCode).json(body)`. Status and header metadata must not be included in the JSON body.

Recognize the known parser error in the host's global handler, before the generic mapper.
For Fastify:

```ts
if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
  return reply.code(413).send({ error: 'REQUEST_TOO_LARGE', message: 'Request too large' });
}
if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
  return reply.code(400).send({ error: 'INVALID_INPUT', message: 'Invalid request body' });
}
const { statusCode, headers, body } = toHttpErrorPayload(error);
if (headers) reply.headers(headers);
return reply.code(statusCode).send(body);
```

For Express, install this error middleware after the parser and adapter routes:

```ts
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof Error && 'type' in error && error.type === 'entity.too.large' &&
      'status' in error && error.status === 413) {
    res.status(413).json({ error: 'REQUEST_TOO_LARGE', message: 'Request too large' });
    return;
  }
  if (error instanceof Error && 'type' in error && error.type === 'entity.parse.failed' &&
      'status' in error && error.status === 400) {
    res.status(400).json({ error: 'INVALID_INPUT', message: 'Invalid request body' });
    return;
  }
  const { statusCode, headers, body } = toHttpErrorPayload(error);
  if (headers) res.set(headers);
  res.status(statusCode).json(body);
});
```

Import `Request`, `Response`, and `NextFunction` as types from `express`. These branches use the
[Fastify content parser errors](https://fastify.dev/docs/latest/Reference/Errors/#fst_err_ctp_body_too_large)
and [body-parser error types](https://expressjs.com/en/resources/middleware/body-parser/#errors);
do not map arbitrary objects solely because they expose status 413.

Hosts explicitly map their known body-parser size errors to `413 REQUEST_TOO_LARGE`; unknown or
database errors retain the non-leaking `500` mapping. Schema validation and host item-count checks
use `400 INVALID_INPUT`. Reject an oversized bulk request as a whole; do not split or partially post it.

Authentication must precede tenant-based accounting. Use verified authentication context for tenant
buckets, never caller-selected tenant headers or resource IDs. Protect unauthenticated requests with
a bounded abuse key and configure trusted proxies explicitly. Hosts own bucket retention/capacity,
body-byte limits, stricter bulk/entry limits, concurrency admission, and bounded queues.

Library bounds remain 100 transactions per bulk request and 200 items per pagination page (default
50). Transaction entries have no shared maximum; request-byte and stricter item limits are host policy.
The PostgreSQL adapter exposes pool maximum, idle timeout, and connect timeout; connect timeout is
not a query deadline. This contract adds no query timeout, export endpoint, or export concurrency control.

Operators must document deployed limits, units, defaults, proxy topology, and remaining gaps. An
in-process limiter resets on restart and does not coordinate replicas; distributed enforcement belongs
to the host. These free protection contracts require no subscription or commercial entitlement check.

## Canonical contract

The source-of-truth HTTP contract is [`openapi/openapi.yaml`](./openapi/openapi.yaml). Runtime contract definitions and OpenAPI must change together and pass `bun run contract:verify`. See the repository [integration guide](../../docs/integration/README.md) for host responsibilities and conventions.

The shared statement contracts cover `GET /v1/accounts/{id}/statement` and
`GET /v1/accounts/{id}/credit-statement`; both require explicit `from` and `as_of` boundaries and
use the common opaque cursor/limit contract.

Scoped list endpoints accept an optional `where` query parameter containing URL-encoded JSON.
For example, `?where=%7B%22balance_minor%22%3A%7B%22gte%22%3A%220%22%7D%7D` filters accounts
whose balance is at least zero. Filters are ANDed, use only each endpoint's documented public
fields, and support `eq`, `ne`, `in` plus numeric/date comparisons where applicable. The decoded
value is limited to 8 KiB; `in` accepts 1–100 non-null values. Omit `where` or pass `{}` for no
additional filter. Invalid JSON, repeated parameters, unknown fields/operators, and invalid types
return the shared `400 INVALID_INPUT` response.
Date-time filter values require a timezone and must be exactly representable in milliseconds.
Extra fractional digits are accepted only when zero (for example, `.123000Z`); values such as
`.123001Z` return `400 INVALID_INPUT` instead of silently changing the comparison boundary.

`MAX_PAGE_LIMIT` is defined in core and re-exported by the HTTP pagination contracts. The default
page size remains transport-owned. The shared core `MAX_FILTER_IN_VALUES` also bounds `in` filters
in both core validation and HTTP parsing/schemas.

Paginated list endpoints accept `limit` (default 50, maximum 200) and an opaque `cursor`, and return
`{ data, next_cursor }`. Reconciliation results can be fetched from
`GET /v1/reconciliation/runs/{id}/results` with typed `where` filters.

Hold reads use `GET /v1/holds` and `GET /v1/holds/{id}`. The nested
`/entries`, `/captures`, and `/credit-allocations` routes return independently paginated lists;
all hold list routes use typed `where` filters and the shared cursor and limit contract.

Before production use, cross-check this README against the OpenAPI shipped with the installed package version and review the [documentation publication checklist](../../docs/integration/versioning.md#documentation-publication-checklist).

`toHttpErrorPayload` returns `HttpErrorPayload` with separate `statusCode`, `headers`, and `body`.
The 429 branch requires the retry body and header. Use the canonical `RateLimitExceededError`
for 429 responses; a custom domain error with status 429 lacks that contract and maps to safe 500.
