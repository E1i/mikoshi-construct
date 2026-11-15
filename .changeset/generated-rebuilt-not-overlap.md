---
'mikoshi-construct': patch
---

A generated file that the update rebuilds no longer counts as an overlap, and a generated file it does not rebuild still does. The rows `moduleFiles` (`contract/module-files.json`), `eslint-edges` (`contract/eslint-edges.json`) and `model` (`architecture/model.md`) in `declarations/generated/` are now `rebuiltOnUpdate: true`, so the update rebuilds them after a merge of main. Before, a conflict on one of them stopped the card. `scripts/core/order/overlap.ts` now treats as derived only the generated rows with `rebuiltOnUpdate: true`, so `knownViolations`, `composition` and the rows with no rebuild overlap again. When the launch lays out lanes, `scripts/nodes/launch/lane-assign.ts` removes derived paths from a card's touches with the same `effectivePaths` function before it compares two cards, and keeps no exception list of its own. `node-launch` may now use `order`.
