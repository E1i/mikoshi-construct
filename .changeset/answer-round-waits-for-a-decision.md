---
'mikoshi-construct': patch
---

An answer round no longer repeats on a card whose open question already had an empty round. Once a round on a `question.agent` or `question.owner` stop leaves nothing, the next answer lease is refused before any session and spends no review round, until the owner records a decision on the card, closes its wait, amends the card, or a new commit lands on its head; then the round starts on its own (law Z8). A card held this way opens one owner wait for a decision, so it shows in the inbox, and a decision on the card closes it.
