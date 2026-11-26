---
'mikoshi-construct': patch
---

The diff shapes `ChangedFile`, `FileStatus`, `TOUCHED` and `MorseRefusal` now live in `scripts/ports/diff.ts`, and `scripts/policy/morse/rules.ts` re-exports them. `reportPath` and `treeReportPath` move from `scripts/core/places.ts` to `scripts/core/factory-paths.ts`, which `places.ts` re-exports, and `scripts/ports/tree-publish.ts` imports them from there. The ratchet row `boundary:ports->rules` goes away (1 → 0) and `boundary:ports->session` falls from 5 to 4.
