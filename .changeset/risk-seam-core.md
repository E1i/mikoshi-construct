---
"mikoshi-construct": patch
---

cli: `construct intake` puts a test file in the risk slice of the code it is named for, and no longer in the slice of any code that shares one of its directory names. Before, every test under `scripts/tests/bus/` followed `scripts/bus/queue.ts` to the R1 slice. The bus files that decide on closing, merging and admitting a task now read R1 like `scripts/bus/queue.ts`: `admissions.ts`, `close-executor.ts`, `merge-executor.ts`, `round-limit-decision.ts` and `update-done.ts`. They read R4 before.
