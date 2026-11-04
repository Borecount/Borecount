# @borecount/postgres-adapter

Drizzle/PostgreSQL adapter for `@borecount/core`.

This package contains infrastructure implementations:

- `DrizzleLedgerRepository`
- Drizzle schema and row mappers
- PostgreSQL client factory
- `borecountDrizzleSchemaPath` for consumer `drizzle.config.ts` files

It is intentionally tied to Drizzle and Postgres.

PostgreSQL 16 is the supported persistence model.

State-changing repository operations use explicit PostgreSQL transactions. The adapter enforces persistence-level tenant scoping, atomicity, and transaction-reference idempotency required by the repository [invariants guide](../../docs/product/invariants.md).

Transaction metadata is stored as nullable PostgreSQL `jsonb` on the immutable transaction header. Omitted metadata is SQL `NULL`, which remains distinct from an empty object. Metadata must be a JSON object no larger than 16 KiB in PostgreSQL's canonical JSON text representation and cannot be updated after insertion. The limit keeps idempotency comparisons and transaction reads bounded while leaving room for compact integration context. Idempotent retries use PostgreSQL `jsonb` equality: object key order is ignored, array order is significant, and any semantic metadata difference is a payload conflict.

Use metadata for stable external IDs, provider references, flags, and other compact context needed to interpret a transaction. Do not embed full provider payloads, audit histories, documents, binary data, or mutable records. Store large data in the owning system and keep only its stable reference in transaction metadata.

## Host-composable unit of work

Use `createUnitOfWork` when a host row or outbox record must commit atomically with Borecount operations:

```ts
import { TenantId } from '@borecount/core';
import { createDbClient, createUnitOfWork } from '@borecount/postgres-adapter';
import { purchaseOutbox } from './db/schema';

const client = createDbClient({ hostSchema: { purchaseOutbox } });
const unitOfWork = createUnitOfWork(client);

await unitOfWork.run(new TenantId(tenantId), async ({ tx, services }) => {
  await tx.insert(purchaseOutbox).values({
    tenantId,
    purchaseId,
    eventType: 'purchase.created',
  });
  await services.transactions.create(posting);
});
```

The callback's Drizzle `tx` and tenant-scoped services share one transaction and RLS context. Register host tables through `hostSchema` to use the typed relational API such as `tx.query.purchaseOutbox`; use `tx.execute(sql\`...\`)` for raw parameterized SQL. A callback failure rolls back every write. Do not retain `tx` after the callback completes. Nested unit-of-work calls, cross-tenant service inputs, and unscoped service operations are rejected. Existing repository/service calls outside this API keep their current transaction behavior.

Hosts must preserve the documented account/grant lock order when doing their own locking before ledger calls. The unit of work does not retry transactions or provide distributed transaction/outbox delivery.

## Host-invoked tenant provisioning

Use `createTenantProvisioningService(client).provisionTenant(input)` to create a tenant and
its initial credential in one transaction, including in a nonempty database. For atomic host
session/outbox rows or ledger seeding, use `provisioning` inside the existing unit of work:

```ts
import { randomUUID } from 'node:crypto';
import { TenantId } from '@borecount/core';
import { ApiKeyRole, generateApiKey } from '@borecount/core/application';
import { createDbClient, createUnitOfWork } from '@borecount/postgres-adapter';
import { onboardingSessions } from './db/schema';

const client = createDbClient({ hostSchema: { onboardingSessions } });
const unitOfWork = createUnitOfWork(client);
// Generate once and durably retain this command in trusted host storage before execution.
const command = {
  tenantId: randomUUID(),
  tenantName: 'Example tenant',
  keyName: 'Initial service credential',
  role: ApiKeyRole.SERVICE,
  rawApiKey: generateApiKey(),
};

const result = await unitOfWork.run(new TenantId(command.tenantId), async ({ provisioning, tx }) => {
  const provisioned = await provisioning.provisionTenant(command);
  await tx.insert(onboardingSessions).values({ tenantId: command.tenantId })
    .onConflictDoNothing(); // Host table uniqueness makes this row retry-safe too.
  return provisioned;
});
// Deliver command.rawApiKey securely; result.key contains metadata, never a stored raw secret.
```

The tenant ID must be a canonical lowercase UUID. Names are trimmed. An identical command
returns `created: false` and the existing active credential. Concurrent attempts for the same
tenant serialize. Existing tenants are accepted only when the tenant name and an active
credential match the command; mismatches conflict without adding keys or changing a tenant.
Matching uses current state, without storing a separate provisioning command history. A revoked credential cannot be restored by replay. The host must retain
the same ID and raw credential across failures, including an unknown commit outcome; do not
regenerate them on retry. If that credential is lost, use an existing tenant ADMIN credential
and normal key creation/revocation for recovery. This API cannot reveal stored secrets or
replace credentials on an existing tenant. A credential collision rolls back the new tenant.
Host callbacks and seeding must also be retry-safe and must propagate failures to roll back.

This is a trusted host capability, separate from tenant-facing `ApplicationServices`. Hosts
own signup, identity, business authorization, secret storage and private session lifecycle.
If a host exposes administrative HTTP provisioning, it owns authentication, authorization,
validation, rate limits and safe error/secret mapping. Borecount adds no public tenant-create
route. Both ADMIN and SERVICE initial roles are tenant-scoped; neither grants authority over
other tenants. Later credentials and revocation use the existing API-key service contracts.
`bootstrapInitialAdmin` retains its empty-key-store behavior. Demo adoption is a separate
host change after a package release containing this API.

### Credit-grant allocation locking

Mutations that touch grant-enabled accounts lock those account rows in account-ID order before locking grants or writing ledger history. Ordinary accounts are not pre-locked; their balance projection is updated atomically in account-ID order, and PostgreSQL takes the row lock for the duration of that update and transaction. Holds read the immutable grant capability without a row lock and reject grant-enabled accounts. Grant issuance never converts an existing account or scans its history. Transaction posting groups inserted entries by account and processes accounts in account-ID order. For each grant-enabled account it performs one `SELECT ... FOR UPDATE` of the account's grants, ordered by `expires_at ASC NULLS LAST, created_at ASC, id ASC`. A grant-enabled account with debit entries loads one latest immutable capacity version per grant and updates that in-memory projection after every allocation so later entries in the same transaction observe earlier allocations. Each new lineage row appends its next cumulative version in the same transaction; versions are rebuildable from authoritative ledger entries and lineage and cannot be updated or deleted. Reversals load the original transaction lineage once per grant-enabled account and copy each original entry's exact grant split.

Grant locks remain held until the posting transaction commits or rolls back. Lineage rows, ledger entries, balance updates, and snapshots are written in that same transaction. The database constraints, row-level tenant policy, and deferred attribution and exact-compensation triggers remain the final boundary checks; there is no mutable authoritative grant-balance column.

## Configuration

The client reads these package-owned variables when equivalent constructor options are not passed:

- `DATABASE_URL` (required)
- `DB_POOL_MAX` (default `10`)
- `DB_IDLE_TIMEOUT` in seconds (default `20`)
- `DB_CONNECT_TIMEOUT` in seconds (default `10`)

JWT, rate-limit, bootstrap, port, and shutdown configuration belongs to the host application, not this package. Environment files must be loaded by the host/runtime before `createDbClient` is called; Node.js does not load `.env` automatically.

## Drizzle config

```ts
import { borecountDrizzleSchemaPath } from '@borecount/postgres-adapter/drizzle-config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/db/schema.ts', borecountDrizzleSchemaPath],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

Apply migrations before starting application code that depends on a newer adapter schema. Numbered migrations upgrade the consolidated `0000` baseline in place; reset databases created by the retired history that predates that baseline. Package downgrade does not roll back a database; follow the repository [upgrade procedure](../../docs/integration/versioning.md).

Before production use, pin compatible Borecount package versions and review the [documentation publication checklist](../../docs/integration/versioning.md#documentation-publication-checklist).
