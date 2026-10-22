---
"mikoshi-construct": patch
---

cli: the board's bus reader lists the queued and leased tasks of the bus and the latest events of each card, which `pnpm board --json` prints beside each card's stage; with the bus database unreadable, `pnpm board` prints `the bus stopped at <ts>: <error>`, the open owner waits from the last board snapshot and the handoff, and the snapshot's age, red when older than two ticks
