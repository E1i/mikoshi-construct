---
'mikoshi-construct': patch
---

cli: an answer stop on paths outside a card's touches now asks to widen only to files the card's tree actually changed. A word in the session's question that looks like a path, such as an event name, or a file the card never changed no longer opens a widening wait. That wait used to stop the next answer round before any session ran.
