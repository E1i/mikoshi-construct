---
'mikoshi-construct': patch
---

The bus no longer reads the tables of the owners above it. `lease.ts`, `observations.ts`, `dependency-wait.ts`, `db.ts` and `bus-readings.ts` take the pull requests, the merged cards and the closed owner waits as values their callers pass in, read through `pr-readings.ts` and the new `card-readings.ts`. The open owner waits are now read by card-record (`openOwnerWaits`, `lastReducedOwnerWaits` and `closedWaitIds` in `scripts/core/card-readings.ts`), and the five bus files have left the no-foreign-table-sql exceptions.
