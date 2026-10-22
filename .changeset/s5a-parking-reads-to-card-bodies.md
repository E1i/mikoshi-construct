---
"mikoshi-construct": patch
---

cli: the `card.moved` or `card.dropped` event `intake --move` writes into the bus carries a dedupe key that names the target lane, not its absolute directory, so the same log replayed in a copy of the repository at another path yields the same keys.
