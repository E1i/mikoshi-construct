---
'mikoshi-construct': patch
---

The answer node no longer loops on one question. Before, an answer session could repeat, word for word, the question that stopped the card. Each time the card stopped again for the agent and went back to the answer queue. Now the card stops for the owner with one decision wait. A decision bound to the card after the stop still lets the answer run again with that decision in its prompt.
