---
'mikoshi-construct': patch
---

`owner:answer #N "words"` now always binds the owner's words to card N as a decision, whatever state the card is in: a leased task, a stop, an open wait or none, or a hold. The bus no longer refuses an answer addressed by card number because the card has no open wait. If the card has an open wait, the same answer closes it and is bound as the decision, whatever the wait needs. A live round sees the decision on its next turn; otherwise the next round takes it. The answer does not release a hold. Answers addressed by `Q<N>` and answers past the round limit behave as before.
