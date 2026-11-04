---
"mikoshi-construct": patch
---

Parallel card sessions now share a CPU budget. Vitest takes its worker limit from the number of live test pools, with a floor of one worker. The pre-push full suite takes turns with `pnpm run quality` in one queue, a session with a clean tree and no unpushed commit runs no pre-push check, and the board shows the machine load.
