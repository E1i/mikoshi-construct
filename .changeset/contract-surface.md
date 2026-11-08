---
'mikoshi-construct': patch
---

`contract/surface.json` declares every command's `--json` forms, exit codes (now `atlas` and `say` too) and unknown-flag refusal, and `tests/contract/contract-surface.test.ts` fails on one it does not declare.
