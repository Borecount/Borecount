# Self-hosted library integration example 0.1.0

This optional, durable, single-process HTTP example consumes released public `@borecount/*` 0.8.0 exports.
It requires no commercial account, enrollment or proprietary credentials. It has no sandbox
creation, seeded demo data, session expiry or scheduled database reset. Do not use the public-demo
cleanup worker or its deployment profile with this database.

## Release and requirements

Keep the entire host checkout, `package-lock.json`, built image digest and private configuration
with each installation release. The Compose image is `borecount-self-hosted:0.1.0`; identify the
source additionally by its Git commit. All four consumed Borecount packages are pinned to 0.8.0.
The recipe pins Node.js 22.15.0 and PostgreSQL 16.16. Native operation requires Node.js 22 and
PostgreSQL 16. Backup tooling additionally requires Bun 1.3.9 and matching PostgreSQL 16
`psql`, `pg_dump`, and `pg_restore`, at least as new as the database server.

`deploy/upstream` contains unmodified Apache-2.0 operational assets from public
Borecount tag v0.8.0, commit `3ec496370d9d55064a4ed3048bbd80608c232c3a`.
`provenance.json` records every copied file's checksum. These include the package migration
chain, security overlay and whole-database recovery tool, plus its package/lock metadata.
The metadata is used for recovery compatibility; the request process uses installed npm packages.
No sibling checkout, source import, unpublished patch or upstream tool installation is needed.
The request image installs only the API workspace production dependencies; pinned `tsx` is a
runtime dependency because the entry point and operator provisioning execute TypeScript.

## Purpose and ownership

Borecount's distributed product is the library. This directory is an optional, independently
runnable integration example shipped alongside the library source; it is not the demo application,
a separate managed product or an additional core package. Copy this directory to integrate or adapt
it to your own host. Authentication, deployment and operator policy stay in the example. No demo
repository, commercial account or library source build is required.

## Install on a dedicated Docker host

Install Docker Compose v2 and Node.js 22. Run all commands from `examples/self-hosted`. Choose a new dedicated Compose project name;
never point this profile at a public-demo volume. Use a private directory outside the checkout
and outside the Docker build context. Commands below do not print secret contents:

```sh
npm ci
export SELF_HOST_SECRETS_DIR="$HOME/.local/share/borecount-selfhost-01"
export SELF_HOST_UID="$(id -u)" SELF_HOST_GID="$(id -g)"
npm run configure
# Retain these exports for every subsequent Compose command.
docker compose -p borecount-selfhost-01 -f compose.yml build
docker compose -p borecount-selfhost-01 -f compose.yml up -d postgres
docker compose -p borecount-selfhost-01 -f compose.yml run --rm operator migrate
docker compose -p borecount-selfhost-01 -f compose.yml exec -T postgres \
  psql -X -U ledger_admin -d borecount_self_hosted -v ON_ERROR_STOP=1 -f /host-release/permissions.sql
docker compose -p borecount-selfhost-01 -f compose.yml run --rm operator provision
docker compose -p borecount-selfhost-01 -f compose.yml up -d api
curl -fsS http://127.0.0.1:8082/health
curl -fsS http://127.0.0.1:8082/ready
```

The generator refuses an existing secrets directory. Keep JSON files mode 0600 and the directory
0700. Password files are 0444 inside that private directory so the PostgreSQL container user can
read its individual secret mounts; never relax directory traversal. Back up everything through a
separately controlled encrypted secret store. On Linux,
`SELF_HOST_UID`/`SELF_HOST_GID` let the non-root application read its own bind-mounted secret files.
The API receives only `app.json`: runtime/authenticator database credentials and JWT signing material.
It does not receive installation, migration, operator or backup credentials. The PostgreSQL init
script runs only for a new volume. Recreating containers preserves durable data; do not run
`down -v` on an installation you intend to retain.

There are four separate database logins: `ledger_migrator` owns package tables;
`ledger_app` receives tenant-scoped runtime grants; `ledger_auth` executes credential lookup functions
without table access; `ledger_operator` performs trusted provisioning. `ledger_admin` is an offline
installation/recovery superuser, never a request credential. The security overlay is applied before
traffic and reapplied after login mapping and upgrades. Runtime has no DDL, DELETE, TRUNCATE, tenant
creation or global credential lookup grants. RLS is defense against accidentally unscoped queries;
arbitrary SQL under the shared runtime credential can set tenant context and is outside that boundary.
Use a dedicated cluster because the overlay's group names are cluster-wide.

## Configure access and provision subsequent tenants

`tenant.json` is a durable operator command containing a UUIDv7, tenant name, initial key name,
explicit `ADMIN` or `SERVICE` role, and a generated raw API key. Keep it private. Edit its display
names before first use if needed. Provisioning uses the supported LL-116 service and performs no raw
library inserts or host credential hashing. An identical command is safely retryable; a changed or
revoked credential/name/role conflicts and is rejected. Retain the original command after interruption.
The CLI outputs only tenant/key IDs and whether creation occurred.

For each additional tenant, generate and persist a new private command before provisioning:

```sh
export SELF_HOST_TENANT_INPUT="$SELF_HOST_SECRETS_DIR/tenant-02.json"
export SELF_HOST_TENANT_NAME='Second tenant' SELF_HOST_TENANT_ROLE=ADMIN
npm run new-tenant
docker compose -p borecount-selfhost-01 -f compose.yml run --rm operator provision
```

The generator uses public `generateUuidV7` and `generateApiKey` helpers and refuses to overwrite a
command. Compose mounts the selected file as `tenant_input`; unset `SELF_HOST_TENANT_INPUT` to select
the initial `tenant.json` again. A native CLI uses `SELF_HOST_PROVISION_INPUT` for its input path and
`SELF_HOST_OPERATOR_CONFIG` for its private operator JSON. Only an authorized operator may invoke
this capability. There is no anonymous tenant-provisioning endpoint.

Clients exchange `x-api-key` for a 900-second bearer at `POST /v1/auth/token`; subsequent requests use
`Authorization: Bearer ...`. Send credentials only over verified HTTPS, never URLs or browser journals.
The host derives tenant context from the credential and checks revocation on each request.
ADMIN keys manage tenant keys; SERVICE keys cannot use `/v1/admin/*`. Adjustments require ADMIN and
use the authenticated key ID as trusted `actor_id`, including retries. Client headers do not select
a tenant. See [public API guide](https://github.com/Borecount/Borecount/blob/v0.8.0/docs/integration/README.md) and the canonical [OpenAPI](https://github.com/Borecount/Borecount/blob/v0.8.0/packages/http/openapi/openapi.yaml) for
asset/ledger/account creation and balanced posting. Exact retries preserve the transaction identity;
conflicting payloads with the same reference are rejected. Keep command fields stable when retrying.

## TLS, secrets and network boundary

Compose publishes the API only on host loopback, port 8082. PostgreSQL has no published port.
Use an operator-managed TLS ingress on the same host, forwarding to `127.0.0.1:8082`; do not publish
the internal HTTP port directly. A sample nginx TLS server block is supplied in
[`deploy/nginx-tls.conf`](deploy/nginx-tls.conf).
Supply a valid hostname certificate and private key through the ingress secret mechanism, restrict
key access, test renewal and verify HTTPS with normal certificate validation before remote access.
Restrict `/metrics`, `/health` and `/ready` to the operator network; API docs may also be restricted.
For a native host, install the same release's npm dependencies, provision the database through
separately controlled installation/migration/operator steps, then start from this example directory:

```sh
SELF_HOST_CONFIG=/private/host/app.json HOST=127.0.0.1 \
  node --import tsx src/self-hosted/index.ts
```

Use local database URLs or verified remote TLS URLs in that JSON. Keep operator config outside the
request process environment. `HOST=127.0.0.1` binds the native host to loopback.

Default trusted proxies are empty, so forwarded headers do not alter client identity and clients
behind the ingress share an IP abuse bucket. Set `TRUSTED_PROXY_CIDRS` in `app.json` to the actual
immediate ingress peer or narrow dedicated network, then recreate the API. Never use a wildcard,
public subnet or caller-controlled forwarding chain. See [configuration reference](CONFIGURATION.md).
For remote PostgreSQL replace the container host URLs with separate restricted logins and TLS
hostname verification (`sslmode=verify-full`) plus the operator's trust roots. Never pass secrets in
command-line arguments, commit them or put them in the build context. Rotate DB login passwords and
JWT signing material through your secret store; support a bounded JWT overlap using
`JWT_PREVIOUS_SIGNING_KEYS`, then remove old keys after token expiry and clock skew.

## Operations and limits

Edit `app.json` for the knobs in [configuration reference](CONFIGURATION.md). This profile
ignores demo/session configuration. Its authentication pool defaults to 2 connections
(`AUTH_DB_POOL_MAX`), in addition to the runtime pool (10). Include both in the database budget.
Runtime SQL has database-enforced `statement_timeout=15s`, `lock_timeout=2s`, and
`idle_in_transaction_session_timeout=15s`; auth queries have a 5s statement deadline. Tune those
role policies for measured workloads; a request timeout does not prove that a query stopped.
The host checks security role composition/overlay at startup and readiness. Privileged runtime
credentials, a missing overlay or mismatched database names fail closed.

The example includes free in-process abuse/read/write/body/bulk/report limits, redacted structured
logs, `/health`, `/ready`, Prometheus `/metrics` and graceful shutdown. These are host policy, not
financial package features.
The runtime and auth pools are both closed during shutdown. Allow at least 15 seconds termination
grace for the default 10-second shutdown deadline and remove traffic before termination.
Logs contain request ID, route template, status and duration, never headers/bodies/query strings or
raw driver errors. Native nginx error logging can expose URLs; the sample uses only safe status logs.
Review any upstream platform logs independently.

Supply operator-owned checks/alerts for readiness failures, sustained 5xx/429, latency, auth failure
spikes, connection saturation, disk/WAL growth, certificate expiry, backup age/checksum failures and
restore-drill failures. Scrape metrics privately; counters reset with the process. Record incident
ownership, contact paths and a backup schedule appropriate to your workload. There is no HA, SLA,
distributed limit enforcement, automatic failover or production RPO/RTO promise from this example.

## Upgrade and rollback

1. Retain the running host release/image digest, private configs and compatible package/tool assets.
2. Stop writers and make a verified backup; rehearse restoration and the target upgrade offline.
3. Stop the API. Copy the target release and build it; run `migrate` once through the
   operator container, then reapply `permissions.sql` through the installation administrator.
4. Start the API, require readiness, repeat posting/retry checks, then reopen traffic and monitor.

Migrations run only in the controlled operator step, never API startup. The CLI checks the complete
applied hash/timestamp prefix and rejects unknown, changed or newer histories. A database with
unrecognized existing tables is not adopted. This host has no host-owned tables, so library migrations
retain their independent `drizzle` journal; it does not use the demo's combined chain/session table.
If you add host tables, introduce a separate journal and a compatible backup tool first. Do not
reuse the vendored 0.8.0 package-only recovery compatibility metadata for an extended host schema.
The earlier demo squashed/combined journal is not an in-place upgrade source for this distribution.

The first host release has no previous host release to upgrade from. The lifecycle drill verifies
forward migration from the released baseline to the full 0.8.0 chain with existing data, and repeated
release application. It does not prove an upgrade from every historical demo or future release.
There is no automatic down migration. Rolling back only the application is safe only after a tested
schema/contract compatibility review; otherwise restore the matched release and database offline,
reconcile any post-snapshot writes, and cut over once. Never run old/new writers concurrently.

## Backup, isolated restore and incidents

Use the shipped upstream tool rather than the demo reset script. Follow the public
[operator runbook](https://github.com/Borecount/Borecount/blob/v0.8.0/docs/runbooks/portable-backup-restore.md)
for inventory, snapshot limits, retention, encryption, integrity, interruption and recovery guards.
Invoke it here with `bun run deploy/upstream/scripts/portable-backup.ts`.
This profile has no host tables/journal; no `--host-migrations` argument is applicable to its pinned tool.

Keep a private libpq service entry and separate passfile (`PGSERVICEFILE`, `PGPASSFILE`) for the
source. The backup role must see all tenants under RLS and call `pg_control_system()`; use a
separately controlled offline backup/admin capability, never either request credential.
Quiesce writers for the documented recovery checkpoint, avoid concurrent DDL and record host image,
package version, schema, configuration and secret recovery boundary alongside the bundle:

```sh
umask 077
bun run deploy/upstream/scripts/portable-backup.ts backup \
  --source ledger_backup /private/backup/bundle-01
```

Back up role definitions/memberships, database ACL/settings, config, signing keys and external
systems separately. The bundle includes all tenants, API-key hashes and financial history, so encrypt
it at rest and off-host, restrict access, schedule retention, and verify hashes after transfer.
For example run a daily operator-owned timer with a unique bundle directory, encrypt and copy to
independent storage, alert on nonzero exit or stale backup, and retain only after validating the new
bundle. Choose frequency/retention from measured data-loss tolerance; this example sets no target.

Restore only to a new dedicated PostgreSQL 16 cluster with a private owner-only 0700 Unix socket
directory, `listen_addresses=''`, matching locale/encoding, same-or-newer patch and no other clients.
Recreate the matched release's roles/memberships (including object owners) from separately secured,
reviewed role definitions; create an otherwise empty recovery database, and leave the API stopped.
Restore does not provision cluster roles or passwords and deliberately refuses a populated database,
source-cluster reuse or a target listening on TCP:

```sh
bun run deploy/upstream/scripts/portable-backup.ts preflight \
  --socket /private/recovery/socket --port 55442 --database borecount_recovery \
  --user recovery_admin /private/backup/bundle-01
bun run deploy/upstream/scripts/portable-backup.ts restore \
  --socket /private/recovery/socket --port 55442 --database borecount_recovery \
  --user recovery_admin /private/backup/bundle-01
bun run deploy/upstream/scripts/portable-backup.ts verify \
  --socket /private/recovery/socket --port 55442 --database borecount_recovery \
  --user recovery_admin /private/backup/bundle-01
```

SQL verification checks schema, migration compatibility, row/history fingerprints, ledger totals,
tenant isolation and immutability. Then configure the matched host's runtime/auth connections to
that offline target; validate balances/history and identical/conflicting API retries, cross-tenant
denial and revocation before opening access. Reissue/rotate compromised keys as required. Disable
source writers and rotate recovered infrastructure secrets before a single-writer cutover.
On an interrupted restore, keep the target offline and inspect connections/state before retry;
`pg_restore` uses one transaction. A hard-kill recovery lock requires operator inspection before removal.
On corruption/version/permission mismatch stop, preserve evidence and use a known-good matched backup.
Never repair accepted financial history through ad hoc deletes or overwrite the live source.

This is **whole-database disaster recovery**, including all tenants. Tenant-scoped portable
export/import is outside this example. Bounded statement pagination is not a consistent portable
tenant snapshot.

## Repeatable verification

Run `npm run test:lifecycle` as an unprivileged OS user with PostgreSQL 16 server/client binaries on
PATH (`PG_BIN` can select their directory), Bun 1.3.9 and installed npm dependencies. It creates two
new private temporary clusters, uses no existing database and removes only its own temporary data.
See [VERIFICATION.md](VERIFICATION.md) for observed sanitized evidence and
limits. Run example type and asset checks with `npm run typecheck && npm test`. Validate the actual TLS hostname/renewal and off-host
backup custody separately on your deployment; the local drill cannot establish those external controls.
