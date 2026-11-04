---
"mikoshi-construct": patch
---

Process heartbeats now keep only their latest value per process in a `heartbeats` table of the bus instead of appending a `process.heartbeat` event on every tick, so an idle bus no longer grows its event journal with them and the nodes' scans over events no longer read them. The supervisor's liveness reading, the loop's live-window check and the board's per-queue slot totals (`src/commands/board/bus.ts`, a reader outside the card's touches, widened here) read the table. `scripts/core/events.ts`, `scripts/core/node.ts` and `scripts/supervisor/liveness-sites.ts` needed no edit: the first keeps `process.heartbeat` as the row type, the second beats through `recordProcessHeartbeat`, the third reads no heartbeat. `node.equivalence` stays an event in the journal, a deliberate scope cut: the shadow window counts its ticks and one-sided keys from events, so its rows still grow the journal.
