---
'mikoshi-construct': patch
---

`contract/factory.json` gains a `modules` section: the factory's target modules, each with the files it owns, the subset that is its public contract, the modules it may use and whether its border is decided, plus the composition roots and an explicit list of what stays out of the graph (tests, templates, tooling). The section is built from `scripts/contract/factory/modules.ts` beside the concepts registry and names under each module the concepts whose owner lies in it. A test now fails when a file under `src/` or `scripts/` belongs to no module and no exclusion, or to more than one. No file moves and no import changes.
