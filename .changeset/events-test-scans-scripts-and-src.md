---
"mikoshi-construct": patch
---

cli: `construct intake` adds `scripts/tests/core/events.test.ts` to the touches of a card that touches a file under `scripts/` or `src/`, because that test reads every source file in both trees.
