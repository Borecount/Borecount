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
