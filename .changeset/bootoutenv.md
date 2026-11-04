---
"mikoshi-construct": patch
---

An env change of the bus agent now reaches the running nodes without a manual `pkill`: every detached bus process carries `BUS_RERUN` and `CONSTRUCT_REVIEW_MODEL` on its command line as `--agent-env` stamps, and `bus:bg` stops and restarts, supervisor first, each process stamped otherwise than the values it is handed. A start handed neither variable restarts nothing; set `BUS_RERUN=as-now` to go back. The merge and update nodes each log their rerun mode when they start.
