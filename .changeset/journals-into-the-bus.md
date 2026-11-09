---
'mikoshi-construct': patch
---

`construct board` and `construct cost` read ladder runs from the bus (`ladder.run`, bus version 3), falling back to `.construct/runs.jsonl` only while the bus holds none; `pnpm bus:import` moves the frozen file in once and is the only writer, since nothing appends `ladder.run` going forward.
