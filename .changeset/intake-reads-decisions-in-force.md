---
'mikoshi-construct': patch
---

`intake --admit` and `--amend` now read the owner's standing decision that moving a witness to another card is not a downgrade. They read it through the decisions port. A removed witness no longer opens an owner wait when another admitted card that has not ended holds the same `run` and `test`. A witness that no card holds still waits for the owner. Every wait intake leaves now writes a `card.waiting` with a wait record. The record uses the kinds and terms of the card section's `waits` table: what the card waits for, who lifts the wait and the deadline. Intake leaves four such waits: unmerged depends (the bus lifts it), a witness downgrade (the owner), a card held until its corrections are confirmed (the owner, or the window under a shard) and a card given to the window (the window). The law registry now has witnesses for Z3 × intake and Z4 × intake in place of their gap rows, and `contract/ratchet.json` drops both rows.
