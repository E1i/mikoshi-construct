---
'mikoshi-construct': patch
---

`construct board` and `construct cost` read the ladder runs from the bus: the `ladder.run` events in the repository's `bus.db` are the run record, and `.construct/runs.jsonl` is read only while the bus holds none. `pnpm bus:import` moves the frozen `runs.jsonl` into the bus, one `ladder.run` event per line, once.
