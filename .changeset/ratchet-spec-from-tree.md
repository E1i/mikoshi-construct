---
'mikoshi-construct': patch
---

The boundary ratchet reads the module spec of the commit a card branched from out of that commit's `contract/factory.json`, instead of evaluating its `modules.ts` in a separate node process. `contract/factory.json` now publishes `composition_imports` in its `modules` section, and `.dependency-cruiser.mjs` takes the composition module and its listed importers from there, so loading the config spawns no process. A test now holds the rule that an import naming no symbols — default, namespace or side-effect — never counts as carrying moved symbols.
