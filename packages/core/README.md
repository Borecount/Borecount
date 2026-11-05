# @borecount/core

Domain-first ledger library for Borecount.

## Design goals

- Explicit invariants in domain classes/use-cases.
- Zero framework/runtime dependencies in core domain model.
- Stable contracts (`input.interface.ts` / `repository.interface.ts` / use-case result contracts).
- Deterministic behavior: same input -> same domain decision.

## Package structure

- `src/base`
  - Shared primitives and abstractions: `Result`, `UnitOfWork`, `Clock`, `Id`, `Money`.
- `src/application`
  - App-facing contracts and services for service/repository boundaries.
- `src/errors`
  - All reusable error classes, `DomainError`, and classification helpers; import from `@borecount/core/errors`.
- `src/utils`
  - Shared helper utilities such as `assertNonEmpty`.
- `src/tenant`
  - Tenant model contracts.
- `src/ledger`
  - Ledger model contracts.
- `src/account`
  - Account model contracts.
- `src/transaction`
  - Transaction invariants, JSON metadata contracts, and create transaction use-case.
- `src/credit-grant`
  - Grant issuance plus immutable consumption/compensation lineage and derived capacity invariants.
- `src/entry`
  - Entry contracts.
- `src/api-key`
  - API key contracts.

## Conventions

Each domain module follows this layout:

- `entity.ts` - domain entity/value object.
- `input.interface.ts` - use-case input contracts.
- `repository.interface.ts` - persistence port contract.
- `index.ts` - module exports.

## Executable domain and application behavior

Core contains executable transaction/account invariants and application services for the supported ledger surface, including:

- `EntryEntity`
- `TransactionEntity`
- `CreateTransactionUseCase`
- ledger and account validation
- transaction, balance, bounded statement, hold, API-key, and reconciliation services
- deterministic reconciliation matching
- credit grant amount, consumption/compensation consistency, and nonnegative capacity validation

Persistence-dependent atomicity and idempotency are implemented by adapters against these contracts. See the repository [invariants guide](../../docs/product/invariants.md) for the guarantees exposed to integrators.
Credit grant posting and lot reconciliation are documented in the [credit grants guide](../../docs/product/credit-grants.md).

### Transaction metadata

`CreateTransactionInput` accepts optional `metadata`, a typed JSON object for host identifiers
and other transaction context. Core passes metadata through without cloning, freezing, or
runtime normalization. Persistence, serialization, idempotency comparison, and HTTP exposure
are adapter concerns. Omitted metadata remains distinct from an empty object.

## Example

```ts
import { CreateTransactionUseCase } from '@borecount/core';
import { assertNonEmpty } from '@borecount/core/utils';

const useCase = new CreateTransactionUseCase(repository);
assertNonEmpty(input.tenantId, 'tenantId is required');
const result = await useCase.execute(command);
```

## Migration strategy

1. Keep API/DB adapters in the host app.
2. Move invariant checks into module use-cases.
3. Keep repository interfaces in `@borecount/core`, implementations outside.

## Integration

Application hosts should normally compose this package through a route adapter and `@borecount/postgres-adapter`. See the repository [integration guide](../../docs/integration/README.md) and [architecture overview](../../docs/product/overview.md).

Before production use, pin compatible Borecount package versions and cross-check behavior against the released OpenAPI shipped with that version; see [versioning and publication](../../docs/integration/versioning.md).

## List filters

Every `list`/`list*` service read accepts an optional persistence-neutral `where`.
All list methods accept it inside an explicit pagination query with `limit` (1–200) and
optional `cursor`, returning `{ data, nextCursor }`. API-key lists receive the authenticated
actor separately; their query cannot select a tenant.

```ts
import { accountListFilter, type WhereFor } from '@borecount/core/application';

const where: WhereFor<typeof accountListFilter> = {
  name: { eq: 'Wallet' },
  currency: { in: ['USD', 'EUR'] },
  balanceMinor: { gte: 0n },
  code: { ne: null },
};
const page = await services.accounts.list({ tenantId, ledgerId, limit: 25, where });
const ledgers = await services.ledgers.list({ tenantId, limit: 25, where: { name: { eq: 'Main' } } });
const keys = await services.apiKeys.listApiKeys(adminActor, { limit: 25, where: { revokedAt: { eq: null } } });
const results = await services.reconciliation.listResults({
  tenantId, runId, limit: 25, where: { status: { eq: 'conflict' } },
});
const holds = await services.holds.list({
  tenantId, limit: 25, where: { state: { eq: 'HELD' }, accountId: { eq: 'account-1' } },
});
const entries = await services.holds.listEntries({ tenantId, holdId, limit: 25 });
```

Hold reads include `getById`, `list`, `listEntries`, `listCaptures`, and
`listCreditAllocations`. Child lists require `holdId`; hold summaries can also be filtered by
their associated `accountId`. Each list returns a page of its corresponding read model.

All fields and operators are combined with AND. Supported operators are `eq`, `ne`, `in`
(1–100 non-null values), plus `gt`, `gte`, `lt`, `lte` for dates and numbers (including
bigint amounts). Use `Date` objects and `bigint` values, not JSON strings. Use `eq: null`
and `ne: null` for nullable fields. Other comparisons follow SQL null semantics, so
`ne: 'value'` does not match null rows. Empty `where` means no additional restriction;
empty field filters, excluded fields, unknown operators, non-scalar values, invalid dates,
and non-finite numbers throw `InvariantViolationError`. Field-specific types, enum values,
and nullability are checked by TypeScript using the existing core entities/read models;
they are not revalidated against a separate runtime schema. Hosts accepting untyped
input must validate it before invoking these services.

Each operation uses a named filter policy beside its entity or read model. Policies
are readonly exclusion arrays, created with `defineListFilter<Model>()(['field'])`,
not a duplicate list of model fields. The two calls let TypeScript accept the explicit
model type while inferring the exact excluded keys. `WhereFor<typeof policy>` derives
scalar field types from the model. Consumers use `PaginationQuery<typeof policy>` directly;
a named query type is needed only when it adds operation-specific fields:

```ts
import {
  type PaginationQuery,
  transactionListFilter,
} from '@borecount/core/application';

export interface TransactionPaginationQuery
  extends PaginationQuery<typeof transactionListFilter> {
  ledgerId?: string;
}
```

`PaginationQuery` takes the filter policy itself and derives `where` through `WhereFor`.
It defaults to no filters (`never`). Shared pagination helpers accept `BasePaginationQuery`
to inspect tenant, limit and cursor independently of the operation filter policy.
Cursors are bound to the tenant, resource, fixed scope and `where`. Reuse the same filter
when following `nextCursor`; consume every page instead of assuming the first page is complete.

| Service method | Filter policy |
| --- | --- |
| accounts.list | accountListFilter |
| transactions.list | transactionListFilter |
| transactions.listEntries | entryListFilter |
| assets.list | assetListFilter |
| ledgers.list | ledgerListFilter |
| apiKeys.listApiKeys | apiKeyListFilter |
| reconciliation.listRules | reconRuleListFilter |
| reconciliation.listResults | reconResultListFilter |
| creditGrants.list, creditGrants.listLots | creditGrantListFilter |
| creditGrants.listLineageByGrant, creditGrants.listLineageByTransaction | creditLineageListFilter |
| balances.listHistory | balanceHistoryListFilter |
| holds.list | holdListFilter |
| holds.listEntries | holdEntryListFilter |
| holds.listCaptures | holdCaptureListFilter |
| holds.listCreditAllocations | holdCreditAllocationListFilter |

Policies and `WhereFor` are exported from `@borecount/core/application`. Entity policies
are also exported from their domain entry points, such as `@borecount/core/transaction`.
ID value objects use string filter values. Persisted entry IDs and entry/transaction
timestamps are non-nullable in filters.

Core validates policy exclusions, query structure and scalar values. The persistence
adapter checks field existence against its existing runtime schema and omits columns
that are absent from the domain read model (for example, transaction hold linkage).
An alternative adapter must perform the same field-existence check before applying
filters. New scalar model fields are eligible unless excluded by the operation policy;
review exclusions when adding private fields. No separate resource-name registry exists.

Lot filters target persisted grant fields such as reference and expiration, not derived
remaining/consumed capacity. Entry amounts use `signedAmountMinor`; lineage amounts use
`amountMinor`. Metadata/JSON paths and API key hashes are not filterable.

PostgreSQL applies these predicates before pagination, alongside mandatory tenant,
ledger/account, time range, fixed filters, and cursor conditions. Filters cannot override
these scopes. Keep the same `where` when following a cursor: changing or removing it is
rejected. Field/operator key order does not matter; `in` value order must remain the same.
Existing unfiltered cursor formats remain compatible (including the legacy history codec).
HTTP adapters expose pagination as `limit`/`cursor` and serialize typed filters through `where`.

Reconciliation result pages use `reconResultListFilter`; candidate ID arrays are excluded
from filtering. Existing reconciliation run responses and reports are unchanged.

## Tenant provisioning

`@borecount/core/tenant` owns `TenantProvisioningService`, its transaction/store ports and
input/result contracts. `@borecount/core/application` re-exports these contracts for application
composition and exposes `generateApiKey`. Generate and securely retain the credential once,
then pass a stable tenant UUID, tenant/key names and explicit ADMIN or SERVICE role to
`provisionTenant`. Core validates roles and exact retry identity; the persistence transaction
port owns serialization and atomic rollback. The capability is reserved for trusted hosts,
separate from tenant-facing application services. See the [adapter provisioning example](../postgres-adapter/README.md#host-invoked-tenant-provisioning)
for host composition, recovery and administrative HTTP ownership.

## Error imports

Import all custom error classes and guards from the single `@borecount/core/errors` entry point:

```ts
import { AccountNotFoundError, DomainError, RateLimitExceededError } from '@borecount/core/errors';
```

Error declarations do not install policy. Hosts still own rate limiting and decide when to throw
`RateLimitExceededError`; `@borecount/http` owns its HTTP response schema and status/body/header mapping.

This is a breaking import change: errors are no longer re-exported by the root, `application`,
`base`, `account`, `transaction`, or `credit-grant` entry points, or by `@borecount/http`.
Update host imports to `@borecount/core/errors`. Existing codes and messages are retained unless
explicitly called out in the release notes.

The former transaction-local `AccountNotFoundError` is consolidated with the application error.
Missing accounts during posting now return `404`, matching account lookups, instead of the
historical default `400`. Currency mismatch definitions share one class; Money preserves its
existing message by supplying it to the constructor.
