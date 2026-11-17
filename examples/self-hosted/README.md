# Self-hosted library integration example 0.8.1

An optional, standalone HTTP example targeting `postgres-adapter@0.8.1` and the other
`@borecount/*` packages at `0.8.0`. Borecount's product remains the library; this directory supplies an integration recipe to copy and adapt.
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

`@borecount/postgres-adapter/migrations` supplies `borecountMigrationsPath` for both migration and
recovery commands. SQL and the journal come directly from the installed adapter; this example has
no copied migration directory.

`deploy/upstream` contains the unmodified Apache-2.0 security overlay and recovery SQL.
Its [provenance manifest](deploy/upstream/provenance.json) records their source tag, immutable commit
and checksums, plus the original source of the adapted [backup runner](scripts/backup.ts). The runner derives compatibility from this
example's `package.json` and `package-lock.json`: exact Borecount versions must agree with the lock and share `major.minor`, and each backup records the npm lockfile's hash. Retain the example commit,
lockfile, image digest and private configuration with each release. The image installs only
production dependencies, including pinned `tsx`.

## Install

Install Docker Compose v2 and Node.js 22, then run from `examples/self-hosted`:

```sh
npm ci
npm run setup
npm run up
```

`setup` creates private credentials, builds the images, starts PostgreSQL, applies package migrations
and the security overlay, and provisions the initial tenant. `up` starts the API and waits for
readiness. The API is available at `http://127.0.0.1:8082`.

Defaults require no exported variables: Compose project `borecount-selfhost-01`, private configuration
in `~/.local/share/borecount-selfhost-01`, and the current user's UID/GID for the request container.
Passwords and signing keys are randomly generated; none are hardcoded. `setup` resumes a complete
existing configuration without replacing secrets or tenant input. If setup is interrupted, resolve
the error and rerun it. An incomplete configuration must be repaired or restored rather than replaced
silently. Keep the private directory outside the repository and Docker build context.

| Routine operation | Command |
| --- | --- |
| Check liveness/readiness | `npm run check` |
| Container status | `npm run status` |
| Follow API logs | `npm run logs` |
| Stop containers while retaining the database | `npm run down` |
| Start again with retained data | `npm run up` |
| Apply migrations and refresh security grants | `npm run db:migrate` |
| Advanced Compose access with the same defaults | `npm run compose -- ps` |

For another installation, set `SELF_HOST_PROJECT` consistently for every command; its default
private directory follows the project name. `SELF_HOST_SECRETS_DIR` and `SELF_HOST_PORT` override the
configuration directory and host port. See [configuration](CONFIGURATION.md#installation-defaults).
Existing installations using the previous documented project/directory retain the same defaults.

The request container receives only `app.json`. `operator.json` holds migration/provisioning
connections; `tenant.json` contains the durable initial tenant command and raw API key. Keep its
credentials private and retain the original command for retries. Back up the configuration through
your encrypted secret store. Preserve the generated directory/file permissions. Database
initialization runs only for a new volume; stopping containers retains data. Do not use `down -v`
for an installation you intend to keep.

## Provision tenants

Create and provision another tenant with one command:

```sh
npm run tenant:add -- --name 'Second tenant'
```

The command saves a new private input file and prints its path before provisioning. Its UUIDv7 and
API key come from public library helpers. Default role is `ADMIN`; use `--role SERVICE` for a service
key. Use `--file /private/tenant-02.json` to choose a durable filename; existing files are never
overwritten. After interruption, retry the saved input rather than generating a new tenant:

```sh
npm run tenant:provision -- --file /private/tenant-02.json
```

Without `--file`, `tenant:provision` retries the initial `tenant.json`. An exact retry reuses its
tenant/key; conflicting fields or a revoked credential fail. CLI output contains IDs and creation
status, never raw keys. Provisioning is an operator capability, with no public onboarding route.

Clients exchange the raw API key from the private tenant input at `POST /v1/auth/token`, using the
`x-api-key` header, then send the returned `access_token` as `Authorization: Bearer ...`.

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
2. Stop external writers and run `npm run down`. Update the example/dependencies and run
   `npm ci`, `npm run compose -- build`, then `npm run db:migrate`. This command keeps the API stopped,
   starts PostgreSQL, applies package migrations and refreshes security grants.
3. Run `npm run up` and `npm run check`, repeat posting/retry checks and reopen traffic while monitoring.

Migrations never run at API startup. The CLI rejects unknown/changed/newer migration histories and
unreviewed tables. This example has only package-owned tables and the independent `drizzle` journal;
it cannot adopt the demo's combined migration history. Adding host tables requires a separate
journal and compatible recovery tooling first. There is no automatic down migration: application-only
rollback needs a verified schema/contract compatibility review, otherwise recover the matched release
and database through the runbook.

Follow the linked recovery runbook without duplicating its procedure here. In all its commands,
replace `scripts/portable-backup.ts` with this example's `scripts/backup.ts`.
The adapted runner handles this package-only schema and has no `--host-migrations` option.
Bundles made with another release layout or npm lockfile are rejected; retain the matching runner
and release files for recovery. Separately
retain this example's secret files, login/group definitions, database settings and image identity.
Recovery covers the whole database; tenant-scoped export/import is outside this example.

## Refresh operational source assets

Dependency updates do not require editing `provenance.json`: npm supplies the migration files and
its lockfile fixes the package versions. Refresh the remaining copied security/verification SQL only
when you intentionally adopt a newer upstream implementation:

```sh
npm run update:upstream -- --ref postgres-adapter-v0.8.1
git diff -- deploy/upstream
npm test
npm run test:lifecycle
npm run test:compose
```

The command resolves the public release tag to an immutable commit, downloads the three source
assets,
recalculates SHA-256 and replaces their snapshot together with `provenance.json`. It preserves the
original ancestry of the adapted backup runner. Review the SQL changes before applying any to a
live deployment; this command updates source files only and does not run migrations or alter roles.
No GitHub login or AI tool is required. An unpublished/missing tag or failed download leaves the
previous snapshot intact.

## Validation and operating scope

Run `npm run typecheck` and `npm test` for type, asset and package-resolution checks;
`npm run test:lifecycle` for the temporary-cluster drill; and `npm run test:compose` for image delivery.
The lifecycle drill needs the recovery prerequisites above; `PG_BIN` can select PostgreSQL binaries.
See [VERIFICATION.md](VERIFICATION.md) for what was observed rather than assuming deployment coverage.

This is a single-process example with no HA, SLA or production RPO/RTO promise. Operators own TLS,
secret rotation, capacity, alerts, incident response and off-host backup policy. Alert on readiness,
5xx/429/latency, database capacity, certificate expiry, stale backups and failed restore drills.
