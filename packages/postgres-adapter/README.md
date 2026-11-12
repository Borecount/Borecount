# @borecount/postgres-adapter

Drizzle/PostgreSQL adapter for `@borecount/core`.

This package contains infrastructure implementations:

- `DrizzleLedgerRepository`
- Drizzle schema and row mappers
- PostgreSQL client factory
- `borecountDrizzleSchemaPath` for consumer `drizzle.config.ts` files

It is intentionally tied to Drizzle and Postgres.

PostgreSQL 16 is the supported persistence model.

State-changing repository operations use explicit PostgreSQL transactions. The adapter enforces persistence-level tenant scoping, atomicity, and transaction-reference idempotency required by the repository [invariants guide](https://github.com/Borecount/Borecount/blob/main/docs/product/invariants.md).

Transaction metadata is stored as nullable PostgreSQL `jsonb` on the immutable transaction header. Omitted metadata is SQL `NULL`, which remains distinct from an empty object. Metadata must be a JSON object no larger than 16 KiB in PostgreSQL's canonical JSON text representation and cannot be updated after insertion. The limit keeps idempotency comparisons and transaction reads bounded while leaving room for compact integration context. Idempotent retries use PostgreSQL `jsonb` equality: object key order is ignored, array order is significant, and any semantic metadata difference is a payload conflict.

Use metadata for stable external IDs, provider references, flags, and other compact context needed to interpret a transaction. Do not embed full provider payloads, audit histories, documents, binary data, or mutable records. Store large data in the owning system and keep only its stable reference in transaction metadata.

## Least-privilege self-hosted deployment

The packaged [self-hosted security runbook](https://github.com/Borecount/Borecount/blob/main/docs/integration/self-hosted-security.md) and
[least-privilege SQL overlay](https://github.com/Borecount/Borecount/blob/main/examples/security/least-privilege.sql) supply the role/RLS setup.
Both assets ship in this package at `dist/security/self-hosted-security.md` and
`dist/security/least-privilege.sql`; the links above also work in the repository and npm README.
Apply the overlay after migrations; it is not installed by the package migrator. With that overlay, configure
separate runtime and credential lookup clients:

```ts
const services = createApplicationServices(runtimeClient, credentialLookupClient);
```

Import `createApplicationServices` from `@borecount/postgres-adapter`. The optional second client uses only
`borecount_security.find_active_api_key` and `find_api_key`; tenant key creation/list/revocation
continue through the runtime client. Without that argument the existing direct-table lookup remains
unchanged, and requires a deployment that permits global credential lookup. Never use a migration
or provisioning connection as the runtime or lookup client. Provisioning requires a separate trusted
operator connection. See the runbook for TLS, secrets, privileges, host authorization and limitations.

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

Authenticate requests before entering the unit of work using
`createApplicationServices(runtimeClient, credentialLookupClient)`. Inside the callback,
`services.apiKeys` deliberately uses the tenant-bound transaction: it can authenticate that tenant's
keys, sees uncommitted key creation/revocation, and rejects foreign-tenant credentials. It does not
use the global lookup connection. An independent connection could miss those uncommitted changes
and therefore cannot provide the unit of work's read-your-writes guarantee.

Hosts must preserve the documented account/grant lock order when doing their own locking before ledger calls. The unit of work does not retry transactions or provide distributed transaction/outbox delivery.

## Host-invoked tenant provisioning

Use `createTenantProvisioningService(client).provisionTenant(input)` to create a tenant and
its initial credential in one transaction, including in a nonempty database. For atomic host
session/outbox rows or ledger seeding, use `provisioning` inside the existing unit of work:

```ts
import { TenantId, generateUuidV7 } from '@borecount/core';
import { ApiKeyRole, generateApiKey } from '@borecount/core/application';
import { createDbClient, createUnitOfWork } from '@borecount/postgres-adapter';
import { onboardingSessions } from './db/schema';

const client = createDbClient({ hostSchema: { onboardingSessions } });
const unitOfWork = createUnitOfWork(client);
// Generate once and durably retain this command in trusted host storage before execution.
const command = {
  tenantId: generateUuidV7(new Date()),
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

For first-run bootstrap, use `createTenantProvisioningService(client).bootstrapInitialAdmin(input)`.
It accepts the same generated `llk_` credential format, assigns a tenant UUID, and returns a
provisioning result when it creates the initial ADMIN credential. It returns `null` when any API
key already exists, including revoked keys. Retain the generated raw key securely before calling
it and deliver that value only when the result is non-null. This global operation must run through
the base adapter client; it is rejected inside a tenant unit of work.

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
Use `TenantProvisioningService.bootstrapInitialAdmin` for bootstrap and handle its `null` result
when the key store is already initialized.

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

## Independent Drizzle migrations

Borecount and the host own separate tables, migration directories, snapshots and database journals.
Keep the released Borecount SQL and journal from the matching checkout unchanged in
`./migrations/borecount`, using `drizzle.__drizzle_migrations`. Generate host migrations only from
host-owned tables, using `host_migrations.__drizzle_migrations`; do not include
`borecountDrizzleSchemaPath` or re-export library tables in the host generation schema.
The exported schema path remains available for schema inspection, not combined migration generation.

For example, create `src/db/host-schema.ts`:

```ts
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const hostEvents = pgTable('host_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
});
```

This example declares only a host table. Its tenant authorization and RLS are host-owned;
it does not change Borecount tables or add a cross-package foreign key. Define the host's
`drizzle.host.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/host-schema.ts',
  out: './migrations/host',
  dialect: 'postgresql',
  migrations: {
    schema: 'host_migrations',
    table: '__drizzle_migrations',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

From the host repository root, generate and inspect the host SQL:

```sh
bunx drizzle-kit generate --config drizzle.host.config.ts --name add-host-events
```

The generated SQL should create only `host_events`; subsequent generations use only the host
snapshots. During a controlled release, apply the unchanged Borecount chain first, then run:

```sh
bunx drizzle-kit migrate --config drizzle.host.config.ts
```

Use the host migration login for this command and the library migration login for the Borecount
step. The host login must not own or have DDL authority over library tables. The
[backup/restore runbook](https://github.com/Borecount/Borecount/blob/main/docs/runbooks/portable-backup-restore.md#separate-migration-ownership-and-upgrades)
shows both migrator calls and recovery with `--host-migrations`. The calls commit separately;
keep application traffic stopped if either step fails. This setup starts with independent journals;
it does not convert an existing combined history.

Apply migrations before starting application code that depends on a newer adapter schema. Numbered migrations upgrade the consolidated `0000` baseline in place; reset databases created by the retired history that predates that baseline. Package downgrade does not roll back a database; follow the repository [upgrade procedure](https://github.com/Borecount/Borecount/blob/main/docs/integration/versioning.md).

Before production use, pin compatible Borecount package versions and review the [documentation publication checklist](https://github.com/Borecount/Borecount/blob/main/docs/integration/versioning.md#documentation-publication-checklist).
