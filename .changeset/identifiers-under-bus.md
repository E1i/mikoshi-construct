---
'mikoshi-construct': patch
---

`scripts/core/identifiers.ts` moves from the card-model module to bus and joins the bus contract. Its identifier shapes — `MAIN_BRANCH`, `isFullSha`, `cardIdOf`, `cardIdOfDescription`, `prBodySha` and `positiveInteger` — move to the new ports file `scripts/ports/identifier-shapes.ts`, in the ports contract; `identifiers.ts` re-exports the five it exported before, so its importers above ports are unchanged, and `scripts/ports/snapshot.ts` and `main-merge.ts` import from the ports file directly. The ratchet row `boundary:bus->card-model` falls from 4 to none and `boundary:ports->card-model` from 4 to 3; no row grows.
