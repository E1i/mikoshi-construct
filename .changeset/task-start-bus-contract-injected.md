---
'mikoshi-construct': patch
---

`task:start` now has its own composition root, `scripts/cli/task-start.ts`, which injects the bus contract into `runTaskStart`. `scripts/ports/task-start.ts` no longer imports `scripts/core/bus-adapter.ts`, so the temporary `boundary:ports->bus` allowance is removed (17 → 16) and `boundary:ports->card-record` falls from 3 to 2. The installed package now runs `task:start` from `dist/scripts/cli/task-start.js`.
