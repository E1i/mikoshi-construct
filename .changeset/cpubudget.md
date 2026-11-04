---
"mikoshi-construct": patch
---

Parallel card sessions now share one CPU budget. Vitest takes its worker limit from the number of live sessions, with a floor of one worker. The pre-push full suite and `eslint .` take turns in one queue, a session with a clean tree and no unpushed commit runs no pre-push check, and the board shows the machine load.
