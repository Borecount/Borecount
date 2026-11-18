# Self-hosted PostgreSQL security baseline

This runbook describes a deployment overlay for least-privilege PostgreSQL access. The library's
default migrations do not install these roles, policies, or authentication functions. Apply the
host-owned overlay in [`examples/security/least-privilege.sql`](../../examples/security/least-privilege.sql)
after Borecount migrations and before starting the application. Keep this overlay versioned and
review it whenever the adapter schema or SQL paths change.

## Database access surface

The public PostgreSQL adapter exports its schema, client, repositories, and provisioning helpers.
Core owns ledger invariants and persistence-neutral services; it has no database or authentication
implementation. Service callers supply tenant/actor context. HTTP owns contracts and safe DTO/error
mapping. Fastify/Express adapters trust host-populated `tenantId`, `apiKeyId`, `apiKeyRole`; they do not
authenticate credentials. Use the explicit [adjustment authorization option](./adjustment-authorization.md).
The host must derive tenant context from authenticated credentials, ignore tenant headers,
reject mismatched resource IDs and enforce its product authorization. Reuse `ApiKeyService` for
ADMIN/SERVICE key management, backing-key revocation and token-context validation.

Application services can reach these tenant-owned tables:

- Tenant and credential records: `tenants`, `api_keys`.
- Ledger data: `assets`, `ledgers`, `accounts`, `transactions`, `entries`.
- Holds and grants: `holds`, `hold_entries`, `credit_grants`, `credit_grant_entries`,
  `credit_grant_hold_allocations`, `credit_grant_capacity_versions`.
- Projections and reconciliation: `balance_snapshots`, `recon_uploads`, `recon_records`,
  `recon_rules`, `recon_runs`, `recon_results`.

The exported `createDbClient` accepts host Drizzle tables through `hostSchema`; host tables are
outside Borecount's policies and must have their own grants and RLS. The client also exposes a raw
PostgreSQL connection and general `execute`, `runTx`, and `runTenantTx` callbacks. Treat all of these
as database access: grants and RLS must protect data even if a query bypasses a repository.

## Roles and host configuration

The overlay creates four `NOLOGIN` roles:

| Role | Intended use | Access |
| --- | --- | --- |
| `borecount_runtime` | Normal application database client | Tenant-scoped table access under RLS, including tenant-scoped key management |
| `borecount_authenticator` | Separate API-key lookup client | Execute only the two credential lookup functions |
| `borecount_credential_owner` | Owner of the credential lookup functions | Read `api_keys` under its narrow credential-owner RLS policy |
| `borecount_operator` | Trusted provisioning and operations connection | Independent administrative access; never use for request handling |

Keep the migration/table owner separate from the runtime role. Have a trusted database administrator
apply the overlay; it takes locks while enabling RLS. Map deployment login roles to the appropriate
`NOLOGIN` roles, store each connection secret in the deployment secret manager, rotate it, and never
place it in source control, logs, or client-visible errors. Use PostgreSQL TLS with certificate and
hostname verification for remote connections. Restrict network access to the database to application
and operator networks.

The host authenticates and authorizes each request before dispatching it to a route. Keep API keys
out of URLs and logs, store only their hashes, return a newly issued secret only once, and use a
separate authenticator connection for lookup. With the overlay, `borecount_security.find_active_api_key(hash text)`
and `borecount_security.find_api_key(id uuid)` are `SECURITY DEFINER` functions that return only the
matching credential row; the authenticator role receives `EXECUTE`, not table access. Compose
services with `createApplicationServices(runtimeClient, lookupClient)`. Use the operator connection only for trusted
provisioning flows.

Perform global authentication before entering `createUnitOfWork(runtimeClient)`. Inside a unit of
work, `services.apiKeys` uses the existing tenant-scoped transaction, so runtime RLS permits lookup
of that tenant's keys without the separate lookup connection. Newly created keys and revocations
are visible immediately inside that transaction; rollback also rolls back those changes. Foreign
tenant credentials are rejected there. Passing an independent lookup connection into the unit of
work would lose this read-your-writes behavior, so it intentionally has no lookup-client option.

The returned lookup row contains credential metadata and its hash, never a stored raw key.
The authenticator can look up any known key ID or hash across tenants; it is a trusted authentication
capability, not a tenant API. Never expose these functions directly to clients. Runtime key-management
responses must use the HTTP DTOs, which exclude hashes. Missing/revoked hashes return no rows; ID lookup
includes revocation state so access-token validation can reject revoked keys.

## Grants and installation

Use a dedicated database. The overlay uses cluster-wide role names: do not reuse these roles for
unrelated databases. Run it transactionally during a maintenance window using a trusted installation superuser
(the credential owner deliberately has no members), with the administrator's configured PostgreSQL service entry (never put a connection password in shell history):

```sh
PGSERVICE=borecount_deploy psql -X --set ON_ERROR_STOP=1 --single-transaction \
  --file examples/security/least-privilege.sql
```

Use fresh, separate login roles. For example, run the following through the trusted administrator,
then set each login's distinct secret interactively with psql `\password` or the secret manager:

```sql
CREATE ROLE ledger_app LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ledger_auth LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ledger_operator LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT borecount_runtime TO ledger_app;
GRANT borecount_authenticator TO ledger_auth;
GRANT borecount_operator TO ledger_operator;
```

Reapply the overlay after mapping logins: its guard rejects runtime membership in privileged groups,
package table ownership, schema CREATE, destructive table grants, excess column updates and direct
global lookup execution. Never grant membership in
`borecount_credential_owner`. Inspect all direct and inherited grants for every mapped login;
these checks do not audit every host/extension function or arbitrary additional schema. Use a
separately controlled migration login that owns the package tables and can perform schema DDL.
It must not share a credential with the request process. For data backfills on FORCE-RLS tables,
explicitly grant that trusted migration login `borecount_operator` while maintaining its separation
from runtime; table ownership alone does not bypass FORCE RLS. Restrict database CONNECT/TEMP and network
access to the intended deployment logins. Configure default privileges so later host migrations do
not grant PUBLIC table access or executable privileged functions.

| Runtime privilege | Tables |
| --- | --- |
| SELECT | All 19 listed package tables, under tenant RLS |
| INSERT | All except `tenants`; provisioning uses the operator |
| UPDATE selected columns | Account balance/reservation/updated timestamp; hold state/remaining amount/applied/void timestamps; snapshot posted amount; `api_keys.revoked_at` |
| Row-lock privilege | UPDATE on `transactions.metadata` and `credit_grants.id` only |
| DELETE / TRUNCATE / DDL | None |

The `transactions.metadata` UPDATE grant exists for row locking; the global metadata immutability
trigger rejects metadata changes. Package routines receive
explicit EXECUTE grants; new tables and host routines need a separate review. The operator has
SELECT/INSERT/UPDATE and an explicit policy on package tables, but no destructive table grants.
The function owner has SELECT on `api_keys` only; the authenticator has no package table grants.
Inspect the deployed membership graph through `pg_auth_members`/`pg_roles` and check effective
privileges with `has_table_privilege`, `has_schema_privilege` and `pg_has_role`; shared credentials or
direct grants to login roles can defeat the intended split. New login mappings require the same audit.

## RLS boundary and limitations

The overlay enables tenant policies across every Borecount tenant-owned table, including
`tenants`, `api_keys`, snapshots, and reconciliation tables. `borecount_runtime` is not the table
owner and receives no `BYPASSRLS`; it cannot inspect another tenant by omitting a tenant predicate.
The four original ledger tables use ENABLE without FORCE; their owner can bypass RLS.
Some other tables already use FORCE, which still does not constrain superusers or BYPASSRLS roles.
The baseline therefore requires a non-owner runtime login with no owner-role membership instead of
relying on FORCE alone. The credential-owner policy is limited to `api_keys`, and the operator policy is separate to support
trusted operations even where `FORCE ROW LEVEL SECURITY` is enabled.

The adapter sets `app.tenant_id` transaction-locally in `runTenantTx`. This setting is a **trusted
application context**, not an authenticated database identity: a SQL injection or arbitrary SQL
execution under the shared runtime credential can set another tenant ID and defeat this isolation.
RLS is defense in depth against accidental unscoped queries, not a SQL-injection boundary. Prevent
injection, parameterize values, minimize raw SQL, and keep the runtime credential private. Do not let
untrusted clients connect directly to PostgreSQL or set tenant context themselves.

## Apply and verify

1. Back up the target and apply the package migrations as the designated migrator/table owner.
2. Apply `examples/security/least-privilege.sql` as a trusted administrator with `CREATEROLE`, before
   application traffic starts. This is a host deployment overlay, not a Borecount migration.
3. Configure separate runtime, authenticator, and operator connection credentials. Do not grant the
   runtime login membership in the operator or migration-owner role.
4. Run the security-baseline integration test on a disposable PostgreSQL database whose name contains
   `test`; the integration helpers reject the production database name and reset the selected test
   database. Use the repository's dedicated test target by default:

   ```sh
   DATABASE_URL_TEST=postgresql://user:password@127.0.0.1:5433/luxledger_test \
     bun test packages/postgres-adapter/test/integration/security-baseline.integration.test.ts
   ```

   If you override `DATABASE_URL_TEST`, verify the parsed host, port, and database name yourself
   before running. The integration suite drops and recreates schemas; a database name containing
   `test` is only a guard, not proof that the target is disposable. Do not point it at shared,
   staging, or production data.

There is no separate trusted tenant-export bypass in the package. Collection pagination, statements
and direct host SQL use the authenticated tenant and the same runtime grants. Whole-database dump,
restore and repair remain privileged operator workflows with separately controlled backup credentials.
These read APIs do not promise a frozen multi-request export; see the statements limitation in
[invariants](../product/invariants.md). Tenant portability remains a separate free capability.

The acceptance evidence is split by behavior:

| Evidence | What it covers |
| --- | --- |
| `packages/postgres-adapter/test/integration/security-baseline.integration.test.ts` | Role grants, RLS isolation, credential lookup boundaries, and runtime denial of privileged access |
| `packages/core/src/application/services/api-key-service.test.ts` | ADMIN/SERVICE policy, revoked keys and token-context mismatches without a database |
| `packages/postgres-adapter/test/integration/unit-of-work.integration.test.ts` | Host schema composition, shared transaction and host-row rollback |
| `packages/postgres-adapter/src/client.test.ts` | Client tenant-context behavior and database-error translation |
| `packages/postgres-adapter/src/client-error-privacy.test.ts` | Safe errors without raw database details |
| `packages/express-routes/src/parity.test.ts` | Equivalent host-facing behavior through Fastify and Express |

Before accepting a deployed host, capture logs and responses while sending unique canary values in
Authorization, x-api-key, Cookie, Set-Cookie, body/query and invalid request IDs; exercise both expected
4xx and injected coded database/readiness 5xx errors. Assert that no canary, SQL text, connection URL,
raw driver message, DETAIL or cause appears, and that each 5xx has safe correlated context. Verify token
revocation on the next request, tenant-header spoofing and the explicit adjustment authorization
callback through the actual authentication middleware. Reuse the host's logging and error-observability
tests; do not substitute package mocks for this check. Configure explicit header redaction,
bounded/validated request IDs and safe error serializers.

The reference API host lives in the separate Borecount-demo repository. Source inspection of
`apps/api/src/api/server.ts` at `bf1d0ae18831b8980e3ecdcc534e6ff6ba0106c2` found request logging disabled
and credential-derived tenant context, but raw readiness errors are logged and incoming request IDs
are accepted without length/format validation. This is not captured-log or deployed-host evidence.
Its TLS, secret-manager setup and full composed privacy remain an explicit host acceptance gap.
This overlay does not add a restore feature or change the package's default migration behavior.
