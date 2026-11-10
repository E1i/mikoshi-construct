---
'mikoshi-construct': patch
---

`task:start` reads a card's body from the latest `card.admitted` in the bus that carries it, not from the `card_bodies` projection, so a card amended moments before its start is no longer refused as edited past intake while the reducer has not folded the amend yet. A parking file that differs from the admitted body is not read.
