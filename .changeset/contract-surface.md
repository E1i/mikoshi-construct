---
'mikoshi-construct': patch
---

`contract/surface.json` declares every command's `--json` forms, exit codes (now `atlas` and `say` too) and unknown-flag refusal, and `tests/contract/contract-surface.test.ts` fails on one it does not declare. `contract:bump` diffs the two new sections, and `cost --expect --json` now carries a top-level `schemaVersion` like every other contracted `--json` output.
