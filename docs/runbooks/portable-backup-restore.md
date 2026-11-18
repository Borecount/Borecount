# Self-hosted PostgreSQL backup and verified restore

Use this procedure for whole-database disaster recovery from the
[squashed Drizzle baseline](../../drizzle/0000_2026-11-09-baseline.sql). The
[LL-35 local drill](./backup-restore-drill-mvp.md) records the historical procedure.
Recovering one tenant requires a separate export/import workflow with tenant scoping, authorization,
and validation of shared dependencies. The archive contains all tenants and may contain sensitive
ledger history, reconciliation inputs and API key hashes.

## Inventory and custody

- Keep the database bundle, matching Borecount package release/checkout, migration SQL, Drizzle
  journal, lockfile, and host release or image digest. Record the PostgreSQL and extension
  versions, database locale/encoding and host migration version.
- Separately back up host-owned role definitions and grants, database-level settings/ACLs, extension
  installation, role memberships, `pg_hba.conf`, deployment configuration, queues, object/blob
  storage, and any other databases the host depends on. A custom dump preserves object ownership
  and object ACLs and expects the named roles to exist. Restore maps objects to the target's
  default tablespace. Foreign tables depend on their external sources.
- Keep database passwords, signing and encryption keys, backup credentials, and passfiles in a
  separate recoverable secret store. Use TLS with hostname verification for a remote source and
  restrict who can read a bundle or run a restore. Keep working directories and temporary storage
  private and encrypted. Test access to backup data and secrets independently.
- If host state spans systems, define the application recovery boundary in advance. Quiesce
  writers or coordinate application checkpoints, then record the host/blob/queue versions that
  match the ledger snapshot.

## Create a bundle

Use Bun, matching PostgreSQL 16 `psql`, `pg_dump` and `pg_restore` binaries from a patch
at least as recent as the source server, and the checkout matching the deployed Borecount package
versions and lockfile. Use UTF-8. The trusted backup role needs full data access through RLS,
including FORCE RLS, and permission to call `pg_control_system()`. Supply the source through a
libpq service profile and a separate passfile or other secure authentication. Keep the profile and
credentials out of the repository. Avoid concurrent DDL and keep the service bound to one primary
for the operation.

The tool always checks this checkout's `drizzle/` history against
`drizzle.__drizzle_migrations`. Keep library SQL, timestamps and journal unchanged. Host tables
use a separate migration directory and `host_migrations.__drizzle_migrations`. When that host
journal exists, pass `--host-migrations /srv/host-release/drizzle` to **every** command
(`backup`, `preflight`, `restore`, and `verify`). Supply only the host's journal
(`meta/_journal.json`) and its referenced SQL files; do not copy library migrations into it.
The bundle records both independent histories and recovery requires their exact SQL hashes and
timestamps. Retain both migration directories with their matching releases. The backup tool does
not apply migrations. Other host migration systems require their own compatibility checks.

### Separate migration ownership and upgrades

Generate host migrations from host-owned tables only. The host must not change Borecount tables
or use a combined schema snapshot that generates library DDL. Keep library and host migration
generation configurations and snapshots separate. Host foreign keys referencing library tables
require release compatibility checks; independent journals do not resolve schema conflicts.
Use separate migration logins and table ownership to enforce this boundary: the host migrator must
not own Borecount tables or inherit the library owner's role. Grant only the library access needed
by host dependencies, such as REFERENCES for an approved foreign key.

Run one controlled release process before application traffic, first migrating Borecount and then
the host. For example, with PostgreSQL Drizzle instances using the respective migration logins:

```ts
import { migrate } from 'drizzle-orm/postgres-js/migrator';

await migrate(borecountMigrationDb, {
  migrationsFolder: './migrations/borecount',
  migrationsSchema: 'drizzle',
  migrationsTable: '__drizzle_migrations',
});
await migrate(hostMigrationDb, {
  migrationsFolder: './migrations/host',
  migrationsSchema: 'host_migrations',
  migrationsTable: '__drizzle_migrations',
});
```

Each chain advances independently: a host timestamp newer than an upcoming library migration
cannot cause that library migration to be skipped. Copy the released library chain unchanged when
upgrading; never renumber or retimestamp applied migrations. Each migrator call has its own
transaction. If the host step fails after the library step commits, keep traffic stopped, resolve
the failure and retry the release. Rehearse both steps against a restored copy before deployment.
The example supports clean installations with separate journals; it does not convert a previously
combined journal. Recreate disposable demo databases rather than rewriting applied history.

```sh
umask 077
mkdir -p /srv/private-bundles
bundle=/srv/private-bundles/"$(date -u +%Y%m%dT%H%M%SZ)"
bun run scripts/portable-backup.ts backup --source ledger_backup "$bundle"
# Independent host migration journal:
# bun run scripts/portable-backup.ts backup --source ledger_backup \
#   --host-migrations /srv/host-release/drizzle "$bundle"
```

The dump and SQL checks import the same exported repeatable-read snapshot. The bundle is published
under its final name only after the custom archive and versioned manifest are complete. The manifest
records SHA-256, size, source cluster identity, tools, package versions, Drizzle timestamps and SQL
hashes, a UTC snapshot acquisition interval, and private verification fingerprints. A write
committed after snapshot acquisition is outside that recovery boundary. PostgreSQL sequences have
nontransactional state and may retain gaps. Back up only completed bundle names and exclude
`.incomplete-*` staging directories. Plan disk capacity for the dump, a restore-side private copy,
and PostgreSQL verification sort space. Set `TMPDIR` to a private encrypted volume if needed.

## Store off-host

Run a daily job under a dedicated OS account, with a scheduler lock to prevent overlap and an alert
on failure or missed uploads. Choose cadence and retention from your own recovery objectives.
These examples use separate remote credentials and encrypted repositories. Keep a versioned or
append-only copy and give retention maintenance separate credentials where supported.

```sh
# Example A. Run with the operator's restic repository and secret configuration.
restic backup --tag borecount "$bundle"
restic check --read-data
# Example retention job. Review the dry run before enabling prune.
restic forget --tag borecount --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --dry-run
# After approval, run the same forget policy with --prune in place of --dry-run.

# Example B. ledger-crypt is an rclone crypt remote wrapping independent off-host storage.
rclone copy "$bundle" "ledger-crypt:bundles/${bundle##*/}"
rclone cryptcheck "$bundle" "ledger-crypt:bundles/${bundle##*/}"
# Review bundles older than 35 days before running the separately authorized retention job.
rclone delete ledger-crypt:bundles --min-age 35d --dry-run
```

Use a complete bundle directory per recovery point. For rclone, use timestamped directory retention
in production so deletion happens at bundle granularity. If the wrapped backend lacks a compatible
hash, download into private scratch and run preflight. Periodically retrieve and verify a complete
bundle from the remote. A local checksum detects damage. Repository authentication, access control
and immutable storage protect against replacement of both archive and manifest. Treat archives as
trusted privileged input. [restic repository checks and retention](https://restic.readthedocs.io/en/stable/045_working_with_repos.html) ·
[rclone cryptcheck](https://rclone.org/commands/rclone_cryptcheck/)

## Restore in isolation

1. On a recovery host or offline container, initialize a fresh PostgreSQL 16 cluster with a patch
   at least as recent as the source. Use the source encoding, locale provider, collation and
   extension binaries. Set `listen_addresses = ''` and one private Unix socket directory owned
   by the operator with mode `0700`. Stop all other clients. Create a new empty recovery database
   from `template0`, plus the required role definitions and memberships. For the
   [least-privilege overlay](../integration/self-hosted-security.md), create its four NOLOGIN
   roles before restoring and provision logins separately. The archive restores the overlay's
   objects and ACLs. If the source used a nondefault database owner, supply the same owner when
   creating the target. Restore database-level security/configuration separately.
2. Run preflight and restore with a trusted local PostgreSQL superuser. Keep application/network
   access disabled throughout verification. The target must be a separate PostgreSQL system,
   have only the default administrative database and the recovery database, and have no other
   client sessions. There is no destructive override.

   ```sh
   target_socket=/srv/recovery/socket
   target_port=55432
   target_database=ledger_recovery
   target_user=recovery_admin
   for step in preflight restore; do
     bun run scripts/portable-backup.ts "$step" "$bundle" --socket "$target_socket" \
       --port "$target_port" --database "$target_database" --user "$target_user" || break
   done
   ```

   For a database with the independent host journal, use this variant instead, retaining the
   target variables above and the host migration directory from the backed-up release:

   ```sh
   host_migrations=/srv/host-release/drizzle
   for step in preflight restore; do
     bun run scripts/portable-backup.ts "$step" "$bundle" \
       --host-migrations "$host_migrations" --socket "$target_socket" \
       --port "$target_port" --database "$target_database" --user "$target_user" || break
   done
   # After isolated host/API checks and retries:
   bun run scripts/portable-backup.ts verify "$bundle" \
     --host-migrations "$host_migrations" --socket "$target_socket" \
     --port "$target_port" --database "$target_database" --user "$target_user"
   ```

3. Restore checks the private archive copy and uses one PostgreSQL transaction. On corruption,
   missing files, compatibility errors, or a nonempty target, resolve the cause before retrying.
   A Drizzle history mismatch requires the matching historical release and its recovery process.
   Never edit migration history to force a match. If interrupted before commit, wait for the
   restore backend to exit and run preflight again. If commit may have completed, run `verify`
   with the same arguments. Keep a failed verification target offline and create a separate empty
   recovery target for another attempt. A hard kill can leave a `.borecount-recovery.lock` directory
   beside the private socket. Remove it only after confirming that the previous tool and its
   PostgreSQL restore backend have exited and the cluster is still offline.
4. SQL verification compares the schema (including owners and ACLs), exact Drizzle history, table
   contents and ledger totals against the backup. It checks balanced postings, tests tenant reads
   as a non-owner, and probes immutable metadata and grant history when rows are present. The
   baseline alone scopes fewer tables than the security overlay. Check host-owned tables and
   policies separately. Validate real runtime and authenticator logins, secret-dependent auth,
   external services, and an exact retry plus a mismatched retry of a known request in isolated
   deployment. Run `verify` again after retry to confirm the snapshot stayed unchanged, then
   authorize cutover separately.

## Drill and recovery limits

With the checkout's frozen Bun dependencies installed and PostgreSQL 16 binaries on `PATH`, run:

```sh
bun run scripts/portable-drill.ts
```

The drill starts and stops two new socket-only clusters and seeds two synthetic tenants, balanced
postings, grants, and a host table managed by an independent host journal. It verifies a library
upgrade after a newer-timestamped host migration, plus a no-op rerun of both migrators. It rejects
missing or changed migration inputs before accepting a backup or recovery. It uses the public application services to replay restored
postings under the runtime role. An exact retry must return the original transaction ID without
another posting, and a changed payload must fail. The second SQL verification checks that neither
retry changed the restored snapshot. Record sanitized results, elapsed restore and verification
time, snapshot boundary, and what was recovered. See the [recorded drill](./portable-backup-evidence.md).

A logical snapshot recovers one database at one captured boundary. It cannot replay subsequent
writes. For finer recovery granularity, consider PostgreSQL physical base backups and continuous
WAL archiving, and separately drill timeline selection, WAL completeness and recovery targets.
The self-hosted operator owns retention, monitoring, secrets, restore drills and cutover. Local drill
timings provide no production RPO or RTO guarantee.
[PostgreSQL logical dumps](https://www.postgresql.org/docs/16/app-pgdump.html) ·
[PostgreSQL continuous archiving and PITR](https://www.postgresql.org/docs/16/continuous-archiving.html)
