---
'mikoshi-construct': patch
---

One owner word on a card is now one act. A decision recorded with `--card #N` queues an answer task for card N after a `question.agent` stop on its pull request, as it already did after a `question.owner` stop. Before, an answer task that the stop had already spent kept the decision's continuation from being queued. Closing a card's wait with the owner's channel word `Q<N>: …` records that word as a decision bound to the card, so the same answer task is queued. A later `decisions:add --card #N` with the same words writes no second decision and queues no second task. When a card stopped on paths outside its touches gets a decision bound to it, or its wait is closed with the owner's word that no widening is needed, the launch hold is lifted and the next launch cuts the card's tree from main.
