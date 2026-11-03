---
"mikoshi-construct": patch
---

Process heartbeats now keep only their latest value per process in a `heartbeats` table of the bus instead of appending a `process.heartbeat` event on every tick, so an idle bus no longer grows its event journal with them and the nodes' scans over events no longer read them; the supervisor's liveness reading and the loop's live-window check read the table.
