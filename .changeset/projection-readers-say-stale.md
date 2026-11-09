---
'mikoshi-construct': patch
---

Projections that lag their events now say so. The reducer writes a watermark for `owner_waits` and `decisions` beside `snapshot`, and `readCurrent` in `scripts/core/bus-readings.ts` checks each projection's mark against the latest event of its catalogued types; `bus:inbox` prints `<projection> is stale: reduced through event N, behind <type> M` and exits 1 instead of answering from the old rows. The stall alarm in `lane-assign` names a merge denial only when it was written for the PR's current head, so a denial of an old head is no longer read as the cause.
