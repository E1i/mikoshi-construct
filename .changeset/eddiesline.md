---
"mikoshi-construct": patch
---

A launch or answer session that reaches the context warn now writes a handoff and stops, and the bus continues the card in a fresh session from that handoff, whatever its `continue` field says, instead of pushing the unfinished work. Past `MAX_RESTARTS` the card stops with no push and says so; a launch report without a valid handoff stops the card the same way. The spend warn keeps its behaviour.
