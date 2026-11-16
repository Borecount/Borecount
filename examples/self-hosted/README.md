# Self-hosted library integration example 0.1.0

An optional, standalone HTTP example consuming published `@borecount/*` 0.8.0 packages. Borecount's
product remains the library; this directory supplies an integration recipe to copy and adapt.
It requires neither the demo application nor a commercial account. It has no sandbox provisioning,
seeded data or scheduled reset. Keep its database separate from disposable demo installations.

## Documentation map

| Subject | Authoritative reference |
| --- | --- |
| This example's installation, provisioning and release commands | This README |
| Settings, authentication policy, limits and monitoring | [CONFIGURATION.md](CONFIGURATION.md) |
| PostgreSQL role model, grants and RLS limitations | [Security baseline, v0.8.0](https://github.com/Borecount/Borecount/blob/v0.8.0/docs/integration/self-hosted-security.md) |
| Backup custody, off-host storage, isolated restore and interruption recovery | [Recovery runbook, v0.8.0](https://github.com/Borecount/Borecount/blob/v0.8.0/docs/runbooks/portable-backup-restore.md) |
| Observed results and their limits | [VERIFICATION.md](VERIFICATION.md) |

The release links match the bundled operational assets; use them when running this pinned example.

## Requirements and release assets

The images pin Node.js 22.15.0 and PostgreSQL 16.16. Native operation requires Node.js 22 and
PostgreSQL 16. Recovery additionally requires Bun 1.3.9 and matching PostgreSQL 16 `psql`, `pg_dump`
and `pg_restore` binaries at least as recent as the server.

`deploy/upstream` contains unmodified Apache-2.0 migrations, the security overlay and recovery tool
from public tag v0.8.0, commit `3ec496370d9d55064a4ed3048bbd80608c232c3a`.
Its [provenance manifest](deploy/upstream/provenance.json) records file checksums. The package manifests
and lock metadata there support recovery compatibility; application dependencies come from this
example's own npm lockfile. The image installs only production dependencies, including pinned `tsx`.
Retain the example commit, lockfile, built image digest and private configuration with each release.

## Install

Install Docker Compose v2 and Node.js 22. Run these commands from `examples/self-hosted`, using a new
Compose project and a private secrets directory outside the checkout and Docker build context:

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

The generator refuses an existing directory. Preserve its 0700 directory, 0600 JSON files and 0444
password files: directory permissions protect the passwords locally, while individual secret mounts
let PostgreSQL read them. `SELF_HOST_UID`/`SELF_HOST_GID` let the non-root application read its JSON
mounts on Linux. Back up these files through your encrypted secret store.

The request container receives only `app.json`. `operator.json` holds migration/provisioning
connections; `tenant.json` is the initial durable onboarding command. The installation administrator
applies `permissions.sql` separately. PostgreSQL initialization runs only for a new volume; container
restarts retain data. Do not use `down -v` for an installation you intend to keep.

The recipe maps `ledger_app`, `ledger_auth` and `ledger_operator` to the security baseline's runtime,
authenticator and operator groups. `ledger_migrator` owns package tables; `ledger_admin` is the
offline installation/recovery administrator. Apply the overlay before traffic and after upgrades.

## Provision tenants

Provisioning uses the public service with a persisted UUIDv7, tenant name, key name, explicit
`ADMIN`/`SERVICE` role and generated raw API key. Edit the initial command's display names before
first use. Retain each private command after interruption: an exact retry reuses its tenant/key;
conflicting fields or a revoked credential fail. CLI output contains only IDs and creation status.

For another tenant:

```sh
export SELF_HOST_TENANT_INPUT="$SELF_HOST_SECRETS_DIR/tenant-02.json"
export SELF_HOST_TENANT_NAME='Second tenant' SELF_HOST_TENANT_ROLE=ADMIN
npm run new-tenant
docker compose -p borecount-selfhost-01 -f compose.yml run --rm operator provision
```

The generator refuses to overwrite an input. Unset `SELF_HOST_TENANT_INPUT` to select the initial
`tenant.json` again. Native CLI input uses `SELF_HOST_PROVISION_INPUT` and
`SELF_HOST_OPERATOR_CONFIG`. Provisioning is an operator capability, with no public onboarding route.

## Configure ingress or native operation

Compose publishes only loopback HTTP on port 8082; PostgreSQL has no published port. Before remote
access, configure operator-owned HTTPS forwarding to `127.0.0.1:8082`, using
[`deploy/nginx-tls.conf`](deploy/nginx-tls.conf) as a template. Supply your hostname, certificate and
private key, verify renewal and normal certificate validation, and restrict monitoring endpoints to
the operator network. Configure trusted peers and remote PostgreSQL TLS as described in
[CONFIGURATION.md](CONFIGURATION.md).

For a native process, provision the database through the same installation/migration/operator steps,
configure separate connection URLs in private `app.json`, then run from this directory:

```sh
SELF_HOST_CONFIG=/private/host/app.json HOST=127.0.0.1 \
  node --import tsx src/index.ts
```

## Upgrade and recover

1. Retain the running release and create a verified backup. Rehearse the target upgrade offline.
2. Stop writers and the API. Build the target release, run the operator's `migrate` command once,
   then reapply `permissions.sql` as the installation administrator.
3. Start the API, require readiness, repeat posting/retry checks and reopen traffic while monitoring.

Migrations never run at API startup. The CLI rejects unknown/changed/newer migration histories and
unreviewed tables. This example has only package-owned tables and the independent `drizzle` journal;
it cannot adopt the demo's combined migration history. Adding host tables requires a separate
journal and compatible recovery tooling first. There is no automatic down migration: application-only
rollback needs a verified schema/contract compatibility review, otherwise recover the matched release
and database through the runbook.

Follow the linked recovery runbook without duplicating its procedure here. In all its commands,
replace `scripts/portable-backup.ts` with this example's `deploy/upstream/scripts/portable-backup.ts`.
The pinned tool handles this package-only schema and has no `--host-migrations` option. Separately
retain this example's secret files, login/group definitions, database settings and image identity.
Recovery covers the whole database; tenant-scoped export/import is outside this example.

## Validation and operating scope

Run `npm run typecheck` and `npm test` for type, asset and package-resolution checks;
`npm run test:lifecycle` for the temporary-cluster drill; and `npm run test:compose` for image delivery.
The lifecycle drill needs the recovery prerequisites above; `PG_BIN` can select PostgreSQL binaries.
See [VERIFICATION.md](VERIFICATION.md) for what was observed rather than assuming deployment coverage.

This is a single-process example with no HA, SLA or production RPO/RTO promise. Operators own TLS,
secret rotation, capacity, alerts, incident response and off-host backup policy. Alert on readiness,
5xx/429/latency, database capacity, certificate expiry, stale backups and failed restore drills.
