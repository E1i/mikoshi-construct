---
'mikoshi-construct': patch
---

The pre-push gate (`scripts/ci/prepush.ts`) and the window gate (`scripts/ci/select.ts --window`) now diff from the last main commit with green CI in the branch's history, read through the CI port. When that cannot be read, they diff from the merge-base with `origin/main` and say why. The pre-push gate no longer runs the full suite locally: a change that would select the full suite runs only the tests each changed path reaches, and the green line says the full run belongs to CI. A failed test whose name declares a capability (`[needs net-listen]`, `[needs ps]`, `[needs miko-session]`) that the sandbox lacks is reported as sandbox norm, separately from real failures. A pre-push run whose only failures are sandbox norm is green and does not ask for another run.
