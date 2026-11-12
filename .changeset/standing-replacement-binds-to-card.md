---
'mikoshi-construct': patch
---

`intake --admit` and `--amend` no longer accept an equivalent witness replacement under an owner decision bound to another card. A standing replacement decision now counts only when it is bound to no card or to the card being admitted, as the standing rules for a witness transfer and for created paths already did. Before this, an allowance given for one card let every card replace its witnesses without the owner.
