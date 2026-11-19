---
'mikoshi-construct': patch
---

The `owner_waits` table of the bus now has one writer module: the folds that open and close an owner wait, the witness-downgrade wait and the waits a decision answers move from `scripts/core/reducer.ts` into `scripts/supervisor/card-waits.ts`, beside the folds that close the waits of an ended card, and the composition root takes `ownerWaitFolds` from there. The `one-writer-per-table` contract test now holds `owner_waits` to that one writer.
