---
'mikoshi-construct': patch
---

`scripts/core/bus-path.ts` and `scripts/core/errors.ts` move from the bus module to layout. `scripts/ports/bus-read.ts` and `scripts/ports/worktree-home.ts` are declared in the bus module and its contract and leave the ports contract. `taskWorktree` moves from `scripts/ports/worktree-home.ts` to `scripts/ports/worktree.ts`. The ratchet row `boundary:ports->bus` falls from 16 to 7, `boundary:ports->events` from 4 to 2, and `gate:bus` from 734 to 643; no row grows.
