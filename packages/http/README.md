# @borecount/http

HTTP mapping helpers for `@borecount/core` domain/application errors.

## Boundaries

- Owns transport contracts and route-level reusable error response specs.
- Maps domain/application errors and `RateLimitExceededError` from `@borecount/core/errors` to transport-safe responses.
- Accepts supported error shapes across bundled public export identities while rejecting raw database/unknown errors as non-leaking `500 INTERNAL_ERROR` responses.
- Contains no HTTP server runtime code and no persistence code.
- Reads no environment variables; JWT, rate limiting, port, and lifecycle configuration belong to the host application.

## Forbidden dependencies
- No framework runtime deps (for example: `fastify`, `express`, `nestjs`).
- No adapter/runtime deps (for example: `drizzle-orm`, `postgres`).
- Keep dependency direction: can depend on `@borecount/core`, never on `apps/*`.

## Public API
- `@borecount/http`:
  - `mapDomainErrorToHttp`
  - `errorResponseSchema`
  - `defaultErrorResponses`
  - `rateLimitExceededResponseSchema`
  - `toHttpErrorPayload`
  - `RateLimitExceededResponse` type
  - `readWhereParameter`, typed list-filter field maps, and URL-encoded JSON schema helpers
  - `HttpErrorDto`, `HttpErrorMapper`, `ErrorResponse` types
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
import { defaultErrorResponses, mapDomainErrorToHttp } from '@borecount/http';

const dto = mapDomainErrorToHttp(error);
reply.code(dto.statusCode).send(dto);
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

The host limiter throws a transport error when it denies admission:

```ts
import { RateLimitExceededError } from '@borecount/core/errors';

throw new RateLimitExceededError(retryAfterSeconds);
```

The delay must be a positive safe integer; round the remaining window up and clamp it to at least
one second before constructing the error. The mapper produces the existing MVP JSON shape and
matching `Retry-After` header. Framework adapters use it for errors caught inside their route handlers.
Errors thrown earlier by host hooks or middleware need the same mapping in the host's global error
handler; adapter registration does not install or replace that handler.

In the host's existing Fastify error handler, after its framework-specific validation handling:

```ts
import { toHttpErrorPayload } from '@borecount/http';

const { statusCode, headers, ...body } = toHttpErrorPayload(error);
if (headers) reply.headers(headers);
reply.code(statusCode).send(body);
```

Express hosts use `res.set(headers)` when headers are present and
`res.status(statusCode).json(body)`. Status and header metadata must not be included in the JSON body.

In the host's size-error branch, before invoking an application service:

```ts
reply.code(413).send({ error: 'REQUEST_TOO_LARGE', message: 'Request too large' });
```

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

## Upgrade note

The `invalidInputPayload` export from `@borecount/http/errors` has been removed. Replace
`invalidInputPayload(message)` with `{ error: 'INVALID_INPUT', message }` in host validation handlers.
This removes a wrapper without changing the HTTP response shape or status.

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

Paginated list endpoints accept `limit` (default 50, maximum 200) and an opaque `cursor`, and return
`{ data, next_cursor }`. Reconciliation results can be fetched from
`GET /v1/reconciliation/runs/{id}/results` with typed `where` filters.

Hold reads use `GET /v1/holds` and `GET /v1/holds/{id}`. The nested
`/entries`, `/captures`, and `/credit-allocations` routes return independently paginated lists;
all hold list routes use typed `where` filters and the shared cursor and limit contract.

Before production use, cross-check this README against the OpenAPI shipped with the installed package version and review the [documentation publication checklist](../../docs/integration/versioning.md#documentation-publication-checklist).
