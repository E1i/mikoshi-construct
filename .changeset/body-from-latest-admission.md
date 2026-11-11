---
'mikoshi-construct': patch
---

`construct intake --amend`, `--export` and the launch node take a card's body from its latest `card.admitted`, not from the `card_bodies` fold, which can lag behind it. An amend made right after an admit builds on the admitted text instead of reverting it, `--export` shows an admission minutes old, and a session continued after an amend starts its handoff from the amended body. A fresh launch waits for the fold of the latest admission that carries a body, so a later admission without a text no longer hides an unfolded amend.
