---
'mikoshi-construct': patch
---

The `heartbeats` table of the bus now has one writer module: retiring the heartbeat rows of a previous generation is a bus operation in `scripts/core/db.ts`, beside the beat it records, and the supervisor only judges which processes are gone. The `one-writer-per-table` contract test now holds `heartbeats` to that one writer.
