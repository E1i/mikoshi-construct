---
'mikoshi-construct': patch
---

The edge lists of the `src/` dependency policy come from `declarations/may-use/`, one file per module of `internal-modules.json`, listing `may_use` (the modules it may import), `may_use_factory` (the files under `scripts/` it may import) and `may_use_factory_within` (more of them for a sub-folder). `pnpm declarations:update` validates the entries and assembles them, sorted by file name, into `contract/eslint-edges.json`. `eslint.config.mjs` reads `ALLOWED_INTERNAL_IMPORTS`, `CORE_FILES_SRC_MAY_IMPORT` and `ALLOWED_FACTORY_IMPORTS` from that file and keeps all of its own rules. To add an edge, add or edit a declaration; `eslint.config.mjs` stays as it is.
