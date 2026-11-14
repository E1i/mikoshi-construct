---
'mikoshi-construct': patch
---

A later changes round on a pull request no longer counts a new finding on code the answer did not touch. When a finding is new (it repeats no earlier round), names repository files, and none of them changed since the previous changes round's head, the review marks it as drip: it stays in the recorded review under `drip`, it does not count toward the changes verdict, and a round left with only such findings records pass. A finding that names a changed file, names no file, or is about a changed pull request description counts as before. Each marked finding is also written to the bus as its own `review.drip` event with the card, pull request, head and text, and the board shows those findings as the card's tail, from which the window can file a continuation card.
