---
'mikoshi-construct': patch
---

Every card that stands in the queue now carries a wait record built from the card section of `contract/factory.json`. The section's new `waits` table gives each kind of wait (`launch`, `depends`, `lane`, `stopped`, `owner`) the one who lifts it (bus, window or owner) and a deadline in minutes. Each record also names the event that opened the wait. A card behind another card's open pull request in its lane gets a `lane` wait. The board's ready, waiting and blocked columns and the handoff's `blocked:` line print only that record. A projection reading that is not stale names the event it was read at. The board's waits and the handoff's `blocked:` line name the event their copy was read at, or, when it is stale, the event it was reduced through.
