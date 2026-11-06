---
'mikoshi-construct': patch
---

The history of owner decisions reads `decision.recorded` events, so every recorded decision keeps its own event and date whatever the `decisions` table holds, and a decision number stays given after its row has left the table.
