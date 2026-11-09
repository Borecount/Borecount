# Versioning, Migrations, and Publication

Borecount publishes every public package and the OpenAPI contract as one
coordinated semantic version. The complete version, breaking-change,
deprecation, npm tag, provenance, and release checklist policy lives in the
[release policy](../governance/release-policy.md).

The current coordinated release is `0.7.0`; see its
[release notes](../releases/0.7.0.md) and the repository [changelog](../../CHANGELOG.md).

## Migration policy

After the pre-production baseline reset described below, migrations in
`drizzle/` are ordered by the numeric filename prefix and are append-only after
publication. A release may add a new migration but must not
edit, reorder, or delete a migration shipped in an earlier version. Production
migrations are forward-only: application rollback does not roll the database
back. A corrective schema change is a new migration.

Before applying migrations, operators must take and verify a restorable backup.
Apply migrations exactly once before starting code that requires the new schema.
For a rolling deployment, every intermediate schema must support both the old
and new application versions; otherwise use a maintenance deployment. Database
downgrades are unsupported.

The current pre-production baseline is
[`0000_2026-11-09-baseline.sql`](../../drizzle/0000_2026-11-09-baseline.sql). It replaces all
previous migrations. Recreate any development or test database initialized
with a previous chain, then apply the current baseline to the empty database.
Backups from a previous chain belong with the matching release and migration
history. Historical release notes describe the migrations shipped at the time.

## Upgrade verification

For releases following this baseline reset, every schema-changing release must
add a real-PostgreSQL test that starts from
the latest published version's complete migration chain and representative data,
applies only the candidate migrations, and verifies both data preservation and
new constraints. Clean-install migration and backup/restore verification remain
required but do not substitute for the upgrade test.

The release PR records the published baseline version and migration filenames in
its versioned release notes. If no migration changed since that baseline, the
release notes state that explicitly and the existing clean-chain verification is
sufficient.

## Consumer upgrade sequence

1. Read every intervening release note and the changelog.
2. Back up PostgreSQL and verify the backup can be restored.
3. Upgrade the complete `@borecount/*` set and commit the lockfile.
4. Recreate dev/test databases when adopting the new pre-production baseline.
   For subsequent upgrades, apply new migrations in numeric order.
5. Run application smoke tests and ledger reconciliation before resuming writes.

The [idempotency reference](./idempotency.md) defines retry behavior for every
state-changing command and should be reviewed whenever a client retry policy is
changed.
