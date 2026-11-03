---
"mikoshi-construct": patch
---

Process heartbeats and the nodes' equivalence marks now keep only their latest value per process in a `heartbeats` table of the bus, instead of appending a `process.heartbeat` or `node.equivalence` event on every tick, so an idle bus no longer grows its event journal and the nodes' scans over events no longer read them; the supervisor's liveness reading and the loop's live-window check read the table.
