---
"mikoshi-construct": patch
---

The supervisor, heartbeat, stalled-session, heal, snapshot, reducer-loop, window-heartbeat, Eddies and liveness readers now read the bus through `events-query` and the card and task owners instead of their own SQL, and leave the foreign-table exception list.
