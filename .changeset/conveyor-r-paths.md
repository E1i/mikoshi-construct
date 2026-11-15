---
'mikoshi-construct': patch
---

The factory path registry and the layer map come from declarations: `declarations/workers/` (one file per worker and its entry file) and `declarations/entries/` (one file per named path, with its `group`, the `layer` that places it and the `lists` it belongs to). `pnpm declarations:update` validates them and assembles, sorted by file name, `scripts/core/factory-paths.ts` (`FACTORY_RUNTIME`, `FACTORY_WORKERS`, `FACTORY_NAMED`, the folder lists and `FACTORY_LISTS`) and `scripts/core/layer-map.json` (`bus:<node>` rows from the worker files, the rest from the entries); both are generated rows rebuilt on update. The shared bus code is one list now: the selector's `BUS_SHARED` and the supervisor's `SHARED_BUS_CODE` are both `FACTORY_LISTS.busShared`, and the law nodes and the composition's worker entries read `FACTORY_WORKERS`.
