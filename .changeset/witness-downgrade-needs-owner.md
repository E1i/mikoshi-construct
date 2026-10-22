---
"mikoshi-construct": minor
---

cli: `construct intake --admit` no longer admits an amend that deletes an admitted witness or drops "red on main" from one; it leaves the admitted body standing, exits 3, names the decision the owner records to allow each downgrade, and with the bus wired writes a `card.waiting` the bus turns into an owner wait. Once the owner's decision scoped to the card names the downgrade, the amend is admitted. Adding or tightening a witness, and a card with no admitted body, are admitted as before
