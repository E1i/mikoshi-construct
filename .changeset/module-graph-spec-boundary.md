---
'mikoshi-construct': patch
---

The factory's module graph now has a boundary check. `scripts/contract/module-graph/imports.ts` builds the import graph of `src/` and `scripts/`, counting type-only imports, re-exports, dynamic `import()` and path aliases; `boundary.ts` holds each edge between two modules against the `modules` section: an import is lawful only when its target is in the target module's contract and that module is in the importer's `may_use`, and an undecided module legalises no edge into or out of it. The report — graph, violations and the strongly connected modules — is byte-identical across runs on one commit. The violations that exist today are recorded in `contract/ratchet.json` as `boundary:<from>-><to>` rows: a new row or a higher count is red, and a row that drops must be lowered in the same pull request. No violation is fixed and no file moves.
