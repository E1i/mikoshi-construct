---
'mikoshi-construct': patch
---

factory: the witness node and the merge gate read a card's body sha and its witnesses from one admission, the latest `card.admitted` that carries the card text, so a witness record taken while a card amend has not yet reached the bus's card-body projection no longer pairs the new body's sha with the previous body's witnesses.
