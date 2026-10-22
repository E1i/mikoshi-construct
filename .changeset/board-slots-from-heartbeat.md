---
"mikoshi-construct": patch
---

`construct board` reads each queue's capacity from its bus node's latest `process.heartbeat` and shows slots as `<queue> used/total`, for example `answer 0/5`; the "(the bus records no capacity)" note is gone. A queue whose node has written no heartbeat shows only the slots in use, with no denominator.
