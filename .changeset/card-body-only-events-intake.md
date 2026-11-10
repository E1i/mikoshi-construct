---
'mikoshi-construct': patch
---

`construct intake --admit` no longer reads a card whose header changed — `who:`, `priority:`, `release:` or any other header line beyond the card line and `touches:` — as already admitted: the change is recorded as an amend. `construct intake --move` records in `card.moved` the body sha of the latest `card.admitted` in the bus, not of the parking file, so a move right after an amend carries the amended body.
