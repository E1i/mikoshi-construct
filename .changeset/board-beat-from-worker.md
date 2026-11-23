---
'mikoshi-construct': patch
---

The board timer worker records its own beat on a connection of its own to the bus, right after each page write, so a busy `bus:run` thread no longer makes `miko watch` read a freshly written board as stale.
