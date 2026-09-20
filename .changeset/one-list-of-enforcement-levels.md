---
"mikoshi-construct": patch
---

The enforcement levels are now one list rather than two kept in step. `src/model/schema.ts` owns
`ENFORCEMENT_LEVELS` and `doctor` imports it; `LEVELS` remains exported under its own name, so nothing
that consumed it has to change and `doctor --json` is byte-identical.

The audit in the previous release found the levels declared twice and tied the copies together with a
test, because `doctor` could not read the model at the time and a stopgap was the honest thing to ship.
A guard that confirms two copies agree, kept indefinitely, ends up blessing the duplication it was
meant to be temporary cover for — so now that `doctor` can import from the model, the second copy is
gone rather than supervised.

The test changed with it, from asserting that the two lists agree to asserting there is only one. It
compares by identity rather than by value, which is what makes it able to catch the thing worth
catching: a reintroduced list with the same five entries fails, where a value comparison would have
passed and gone on passing until somebody widened one of them.
