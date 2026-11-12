---
'mikoshi-construct': patch
---

The factory's module graph now checks its cycles. `scripts/contract/module-graph/cycles.ts` holds the `may_use` graph of the `modules` section to be a DAG — a cycle in it, a module naming itself included, is red — and reports the cycles that exist in the source apart from it: each strongly connected set of modules with one example chain, every step of which names the import that carries it. The two graphs are never mixed: a source cycle does not make `may_use` red, and a `may_use` cycle is not a source SCC. Run directly, the script prints the number of modules, the boundary violations by kind, the `may_use` cycles and the source SCCs with their chains. No cycle is fixed and no file moves.
