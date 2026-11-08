---
'mikoshi-construct': patch
---

`contract/surface.json` records the flags each `--json` form passes (`jsonForms`), the exit with which every command refuses an unknown flag (`unknownFlag`), and the shapes of `doctor --factory --json`, `cost --expect --json`, `cost --last --json`, `board --all --json` and `board --geek --json`. A flag, a `--json` form or a refusal the command line has and the contract does not declare fails `tests/contract/contract-surface.test.ts`.
