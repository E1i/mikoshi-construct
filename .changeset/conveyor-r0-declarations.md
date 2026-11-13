---
'mikoshi-construct': patch
---

Modules declare what they own in `declarations/`, one JSON file per entry grouped by kind: `modules` (`layer`, `paths`, `exclude`, `shared`), `contention` (the `bus-restart` area until P-restart) and `generated`, which now holds the generated-file rows that `scripts/core/generated-files.ts` used to list. The package ships `declarations/generated`. `pnpm declarations:update` checks that every tracked file has exactly one owner and rebuilds `contract/module-files.json`.
