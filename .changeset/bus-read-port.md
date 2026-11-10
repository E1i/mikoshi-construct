---
'mikoshi-construct': patch
---

The bus is read through one port, `scripts/ports/bus-read.ts`. A reader asks it for a slice of one event type with the payload fields it needs, and a field the event's contract does not declare is refused. A projection that is behind its events reads stale, through the watermark in `scripts/core/bus-readings.ts`, instead of answering with old rows. The port writes nothing. The board page's gauges and shard decisions, and the window's equivalence ticks, now read through it. A new concept, `bus-read`, counts every other SQL read of a bus table, and the ratchet only lets that count fall.
