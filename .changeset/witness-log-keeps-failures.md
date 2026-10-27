---
"mikoshi-construct": patch
---

factory: a red `witness.recorded` now keeps the names of the failed tests and the first lines of their errors, cut at a limit, after the refusal line. Before, a red witness kept only the last line of the output, so which test failed was lost.
