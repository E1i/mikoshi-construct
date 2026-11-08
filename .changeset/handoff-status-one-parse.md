---
'mikoshi-construct': patch
---

The STATUS line of a handoff is now read in one place, `scripts/core/handoff-status.ts`, and the last STATUS line is the status everywhere. The board used to show the first STATUS line while the loop, the tab window and `miko exit` acted on the last, so a handoff that moved from OWNER to CONTINUE could still show as waiting for the owner. A test fails when a STATUS parse appears outside that module. `handoff:write` under a decisions shard now accepts `STATUS: OWNER` when the handoff's `owner waits` names an open question, since the window cannot decide an item the owner already holds.
