---
"mikoshi-construct": patch
---

cli: `construct board` shows a bus queue's slots as `<queue> used/total`, the total read from the slots its node's latest heartbeat carries; a queue whose node has no such heartbeat shows only the used count, and the `(the bus records no capacity)` note is gone
