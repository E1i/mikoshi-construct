---
'mikoshi-construct': patch
---

The factory reads the OS process table through one port, `scripts/ports/process-table.ts`: a snapshot of rows (pid, parent, group, start, command), the working directories of our client and a CPU sample, with a live adapter over `ps`, `lsof` and `top` and an in-memory one for tests. The port answers facts only and has no notion of a pid being alive; the nine places that ran `ps` or `lsof` themselves now ask it. The three holders that serve a bus stop probing pids: `bus:review:bg` reads the `bus:review` heartbeat, the bus heal stops a recorded node only when the supervisor's snapshot still shows it serving this bus, and a second `bus:run` facing an unreadable process table exits and starts nothing. `liveness-sites` gains the kind `imported-judge`, so a file that imports `alive` or `isAlive` is recorded by name. A seal test turns red on a `ps`, `lsof` or kill zero outside the port, and on a caller that judges liveness beside it.
