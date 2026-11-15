---
'mikoshi-construct': patch
---

Which files and paths each module owns in the module graph is no longer written by hand. `pnpm declarations:update` now also writes `scripts/contract/factory/module-owns.ts` from `declarations/modules/*.json`: each module's `paths` and `shared` entries under `src/` or `scripts/`, a folder as its path with a trailing `**`, leaving out the composition roots and what the graph's exclusions hold. Contract, `may_use`, status, composition roots and exclusions stay hand-drawn in `scripts/contract/factory/modules.ts`, and the generator never rewrites them. A generated part that no longer matches the declarations, and a module present in only one of the declarations and the drawn graph, fail the check. The ownership the graph reports is unchanged.
