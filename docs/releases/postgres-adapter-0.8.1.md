# PostgreSQL adapter 0.8.1

| Component | Version |
| --- | --- |
| `@borecount/postgres-adapter` | `0.8.1` |

This patch makes the existing migration chain installable from npm. It does not change
the ledger or HTTP API. Other public packages remain at `0.8.0`.

## Packaged migrations

The PostgreSQL adapter now includes the released SQL migration chain and `meta/_journal.json`.
Import `borecountMigrationsPath` from `@borecount/postgres-adapter/migrations` and pass it to the
host's Drizzle migrator. Hosts no longer need to copy library SQL files manually. This additive
subpath performs no database work on import; migration credentials, orchestration, security roles
and tenant provisioning remain separately controlled by the host.

The packed-package smoke test checks the public export and byte-for-byte equality of shipped SQL
and journal files against the canonical source. Integration fixtures also remove two timing/order
assumptions without changing production pagination or statement behavior.

## Upgrade from 0.8.0

Upgrade only `@borecount/postgres-adapter` to `0.8.1` and commit the consumer lockfile.
The other packages and OpenAPI remain `0.8.0`. A host can switch its
migration directory to `borecountMigrationsPath` while retaining the existing library journal
(`drizzle.__drizzle_migrations`). Do not renumber or copy library entries into a host journal.
See the [package migration example](../../packages/postgres-adapter/README.md#packaged-postgresql-migrations).

No migration SQL or database schema changed from published 0.8.0. The complete unchanged chain is:

1. `0000_2026-11-09-baseline.sql`
2. `0001_2026-11-10-reconciliation-run-rules-and-history-indexes.sql`
3. `0002_2026-11-10-reconciliation-filtered-history-indexes.sql`

Existing 0.8.0 installations require no new DDL. Financial invariants, idempotency semantics and HTTP
payloads are unchanged; OpenAPI `info.version` remains `0.8.0`. No data conversion is introduced.
Older baseline-reset limitations still apply; a package downgrade does not reverse database history.
