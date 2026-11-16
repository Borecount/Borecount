# Self-hosted 0.1.0 verification

Observed 2026-11-16 using Node.js 22.15.0, Bun 1.3.9, PostgreSQL server/client 16.16 and public
Borecount packages 0.8.0. Only generated synthetic data and newly created temporary resources were
used. No production database, external credentials or commercial service was involved.

## Native installation lifecycle

Reproduce with `npm ci` then `npm run test:lifecycle`; PostgreSQL 16 server/client binaries and Bun
must be available. `PG_BIN` may select the PostgreSQL binary directory. Run as an unprivileged OS
user with permission for local sockets/shared memory. The runner creates two temporary clusters;
restore starts in a separate socket-only cluster with no other clients. After SQL verification,
that recovery cluster is restarted on loopback for offline host/API acceptance.

The passing run measured backup at 0.39 seconds, restore plus SQL checks at 0.50 seconds, and the
whole drill at 6.64 seconds. These are local synthetic timings, not production recovery objectives.

Verified behavior:

- Install the released baseline as a separate non-superuser migrator; apply the unmodified security
  overlay and map separate runtime, authenticator and operator logins.
- Provision the first and a subsequent tenant using the actual operator CLI. Identical retries
  reuse the existing tenant/key; conflicting command fields fail.
- Authenticate through the composed host, create assets/ledger/accounts and a balanced posting.
  The identical retry returns the original transaction; conflicting retry returns the current
  governed 400 `INVARIANT_VIOLATION` contract.
- Deny cross-tenant resource reads with spoofed tenant headers, SERVICE access to admin routes,
  forged adjustment actors, SERVICE adjustments, runtime DDL/TRUNCATE/global key lookup and authenticator table reads. Raw unscoped account reads
  return no rows; a privileged runtime connection is rejected at startup.
- No `/demo/session`, Library bridge or reset route is installed.
- Upgrade populated baseline data to the full released 0.8.0 migration chain; repeat the migration
  step without changing balances, transaction history or entries. Modified journal hashes and unreviewed host tables fail closed.
- Use the exact shipped backup tool, role definitions and an empty isolated recovery database.
  Preflight, restore and SQL verification pass; restoring again into the populated target is refused.
  Restored schema/row fingerprints, migration history, ledger totals, tenant isolation and immutability
  checks pass. Account balances, transaction IDs/references and entry IDs/amounts match exactly.
- On the restored host, exact/conflicting retries and cross-tenant denial behave as before.
  Revoke a key and reject its existing bearer on the next request.
- Unique credential/header/body/query/invalid-request-ID canaries do not appear in captured host
  logs. Denied lookup-function permissions produce sanitized 503 readiness and 500 authentication
  responses without raw database errors; readiness recovers after permissions are restored.
- Exercise the actual process entry point over loopback HTTP and observe clean SIGTERM exit 0.

The upgrade fixture exercises a real forward database migration, not an earlier published host
release (0.1.0 is the first). Whole-database recovery is covered; tenant-scoped export/import is outside this example. Upstream LL-135's corruption/interruption coverage is documented in its
[release drill evidence](https://github.com/Borecount/Borecount/blob/v0.8.0/docs/runbooks/portable-backup-evidence.md).

## Container delivery

`npm run test:compose` built the delivered images and passed on Docker Engine 28.0.4.
It created a new uniquely named Compose project, private generated secret directory and database
volume, then removed only those resources after the check.

It verified clean initialization, explicit migrations/permissions, operator provisioning and exact
retry, non-root request process with only runtime/auth secret mounts, readiness, API authentication,
ledger creation, absence of sandbox provisioning, durable API restart and captured-log secret privacy.
The API port was published on loopback only; the database had no published port.

## Other checks

The standalone example typecheck, public-release asset checks and complete lifecycle passed after
removing all demo imports and UI routes. The example installs released packages into its own
`node_modules`; a resolution test rejects parent-repository workspace dependencies.

The standalone example command `npm audit --omit=dev --audit-level=high --json` completed on
2026-11-16 with exit code 0. It reported zero critical, high or moderate findings and one
low-severity esbuild finding via tsx:
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).
The audit describes a Windows development-server file-read issue. The shipped Linux container uses
esbuild through tsx for transformation and does not start an esbuild development server, so that
trigger is absent from this profile. The dependency remains listed by npm audit; this is a scoped
applicability assessment, not a claim of zero dependency advisories. The example image installs only its production dependencies.


## Practical limits

A local drill does not establish production TLS/DNS/certificate renewal, remote database TLS,
secret-store recovery, off-host backup transfer/encryption/retention, large-volume throughput,
PITR, distributed limits or HA. Follow [README.md](README.md) to validate those operator-owned
controls before opening a deployment. The nginx TLS template is a configuration example; the native
and Compose drills above use loopback HTTP. They make no production RPO/RTO or availability claim.
