# Self-hosted 0.8.1 verification

Observed 2026-11-16 with Node.js 22.15.0, Bun 1.3.9, PostgreSQL server/client 16.16, a candidate
`postgres-adapter@0.8.1` tarball with the other Borecount packages from npm at `0.8.0` and Docker Engine 28.0.4. All installation data was synthetic, using new temporary
resources. Reproduction commands and prerequisites are in the [README](README.md#validation-and-operating-scope).

## Results

| Check | Observed result |
| --- | --- |
| `npm run typecheck` and `npm test` | Typecheck, release-file checksums, independent package resolution and six incompatible local-metadata cases passed. |
| `npm run test:lifecycle` | Installation, provisioning, authentication, posting, retries, upgrade, isolated recovery and process lifecycle passed. |
| `npm run test:compose` | Image builds, initialization, secret mounts, non-root API, provisioning, readiness and durable restart passed. |
| `npm audit --omit=dev --audit-level=high --json` | Exit 0; zero critical/high/moderate findings, one low esbuild finding. |

The lifecycle drill checked first/subsequent tenant provisioning and exact/conflicting retries,
SERVICE/ADMIN and trusted-actor policy, cross-tenant denial, runtime/lookup privilege separation,
revocation, log canaries, sanitized 500/503 responses, readiness recovery and SIGTERM exit 0.
No sandbox, Library bridge or reset route was installed.

It upgraded populated baseline data through the full unchanged 0.8.0 migration chain packaged in adapter 0.8.1 and reapplied it without
changes. Unknown host tables and modified migration hashes were rejected. This is a forward schema
upgrade fixture, not an earlier released host version; this is the first example release.

Recovery used another socket-only cluster. Dependency-version and npm-lock hash mismatches were rejected before creating target tables.
Preflight, restore and SQL checks passed; a second restore
into the populated database was refused. Schema/row fingerprints, migration history, ledger totals,
RLS and immutability checks passed. Balances, transaction/entry identities and restored API retry
behavior matched. After SQL verification, the target was restarted on loopback for host acceptance.
The container check independently verified that the request process received only `app_config` and
that its ledger survived restart. Both runners removed only their own temporary resources.

| Local synthetic measurement | Seconds |
| --- | --- |
| Backup | 0.24 |
| Restore, including SQL checks | 0.23 |
| Complete native drill | 4.79 |

The remaining dependency finding is [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr),
a low-severity Windows esbuild development-server issue. This Linux image uses esbuild through tsx
for transformation and does not start that server; the affected trigger is absent from this profile.
The advisory remains listed by npm audit.

Before npm publication, a candidate tarball supplied adapter 0.8.1 and npm supplied the other 0.8.0 packages for native
and container checks. The container fixture changed only dependency-download URLs in a temporary
copy; the source Dockerfile retained the ordinary npm-ci installation. `update:upstream` also passed
package-specific/legacy annotated-tag, hash, download-failure and invalid-ref tests, and a live refresh from public v0.8.0.

## Coverage boundary

These measurements do not establish production recovery targets, deployed TLS/renewal, remote DB TLS,
secret-store recovery, off-host transfer/retention, large-volume capacity, PITR or HA. Both drills use
loopback HTTP. Upstream corruption/interruption coverage is recorded separately in the
[release recovery evidence](https://github.com/Borecount/Borecount/blob/v0.8.0/docs/runbooks/portable-backup-evidence.md).
