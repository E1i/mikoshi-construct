---
"mikoshi-construct": patch
---

cli: the factory script paths that `construct intake` and the risk matrix read now come from one registry module instead of each holding its own literal copy; every path value stays byte-identical, and the packed factory build gains one file, `dist/scripts/core/factory-paths.js`, which the factory scripts import; one printed line changes: the `Runs:` line of every card `construct intake` cuts with a `src/` or `scripts/` touch now also names `scripts/tests/core/factory-paths.test.ts`, which scans both trees
