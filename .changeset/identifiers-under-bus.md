---
'mikoshi-construct': patch
---

`scripts/core/identifiers.ts` moves from the card-model module to bus and joins the bus contract. Its identifier shapes — `MAIN_BRANCH`, `isFullSha`, `cardIdOf`, `cardIdOfDescription`, `prBodySha` and `positiveInteger` — move to the new ports file `scripts/ports/identifier-shapes.ts`, in the ports contract, and every importer reads them from there; `identifiers.ts` re-exports none of them. The ratchet row `boundary:bus->card-model` falls from 4 to none and `boundary:ports->card-model` from 4 to 3; no row grows.
