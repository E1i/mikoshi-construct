---
"mikoshi-construct": patch
---

cli: `construct intake --admit` resolves a card's depends and blocks against every lane under the parking root, not only the card's own directory, so a card that depends on one parked in another lane is no longer marked unclear
