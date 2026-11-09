---
'mikoshi-construct': patch
---

After the six `src/program.ts` commands the contract-surface change covered, the scripts section of `contract/surface.json` now covers the 39 `package.json` scripts that take flags, and every other script in the registry. `scripts/contract/surface.ts` writes it from a static reading of each script's entry: its flags (`parseArgs` options and `--flag` literals), whether it prints a `--json` form, the exit codes it sets, and whether a strict `parseArgs` refuses an unknown flag. `tests/contract/surface-scripts.test.ts` fails on a flag, a json form, an exit code or a refusal that a script reads as and the section does not declare.
