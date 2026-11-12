# Portable restore drill evidence

Observed 2026-11-09 with PostgreSQL server and clients 16.15, Bun 1.3.9 and Borecount packages
0.7.0. Reproduce with `bun run scripts/portable-drill.ts` from the matching checkout.
The drill used two new private Unix-socket clusters, the squashed Drizzle baseline, the
least-privilege overlay, two synthetic tenants and synthetic host data.

| Measurement | Observed |
| --- | --- |
| Backup, including snapshot checks | 1.00 s |
| Restore, including first SQL verification | 1.26 s |
| SQL verification after API replay | 0.77 s |
| Interrupted attempt through successful restore and API replay verification | 2.41 s |
| Full drill, including provisioning and negative cases | 6.83 s |
| Snapshot acquired (UTC) | 14:21:00.288619–14:21:00.289089 |

The restored snapshot contained the pre-backup marker and excluded the later committed marker.
Schema, ownership, ACLs, migration history, contents and ledger totals matched. SQL tenant and
immutability probes passed. Under the restored runtime role, the exact API retry returned the
original transaction for each tenant, a changed payload failed, and the snapshot remained intact.

The drill rejected source reuse, a non-isolated cluster, a populated target, incomplete bundles or
manifests, checksum corruption, incompatible server/client/package metadata, active recovery lock, and an incompatible
actual migration row. Termination during `COPY` rolled back the restore, after which empty-target
preflight and retry succeeded. Verification also detected a disabled immutability trigger.

These timings cover synthetic local data. Off-host transfer, production volumes, secret recovery,
external host dependencies and cutover were outside the measurement.

## Host migration recovery regression

Observed 2026-11-12 with PostgreSQL server and clients 16.15, Bun 1.3.9 and Borecount packages
0.8.0. The expanded `bun run scripts/portable-drill.ts` passed a package-only backup and full
restore, then applied an appended synthetic host migration through Drizzle and passed backup,
interrupted restore, retry and API replay using `--migrations` with the complete host journal.

| Measurement | Observed |
| --- | --- |
| Host-history backup | 0.95 s |
| Host-history restore, including first SQL verification | 1.11 s |
| SQL verification after API replay | 0.70 s |
| Interrupted attempt through successful restore and API replay verification | 2.12 s |
| Full drill, including default workflow and negative cases | 7.23 s |

The drill rejected omitted host history, modified host SQL, replaced or truncated package history,
duplicate migration timestamps and a path-traversing migration tag. Existing corruption, isolation,
interruption, snapshot-boundary, tenant and immutability checks also passed. Non-directory files in
the package directory did not affect version collection. Only new disposable clusters and synthetic
data were used; no external host deployment or production recovery target was measured.
