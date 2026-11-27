---
'mikoshi-construct': patch
---

`scripts/ports/netwatch.ts` becomes a composition root of the module graph and leaves the ports contract. Its importers, `supervisor/netwatch-root.ts` and `supervisor/run.ts`, are roots already, so the edge from `run.ts` is root to root and needs no `COMPOSITION_IMPORTS` row. The ratchet rows `boundary:ports->bus` fall from 5 to 3, `ports->events` from 2 to 1 and `ports->session` from 4 to 2; no row grows.
