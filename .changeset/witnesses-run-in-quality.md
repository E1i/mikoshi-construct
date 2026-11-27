---
'mikoshi-construct': patch
---

`scripts/ports/witnesses.ts` moves from the ports module to quality and leaves the ports contract. The `Witness` shape and the witness symbols `isChangeWitness`, `unjudgedCommand`, `admittedReachOf` and `FACTORY_TWIN` move from `src/commands/intake/check.ts` to `src/card/witness-fields.ts`, where `Witness` replaces the identical `JudgedWitness`; `check.ts` and `witnesses.ts` re-export them, so their importers do not change. `admittedReachOf` in card takes the runs reader as an argument, so card does not import the covering tests of quality, and `admittedTouchesOf` gives the touches alone. The ratchet row `boundary:ports->quality` falls from 1 to none and `boundary:ports->intake` from 3 to 2; no row grows.
