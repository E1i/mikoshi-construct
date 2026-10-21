---
"mikoshi-construct": patch
---

cli: `construct board` Services no longer lists the session of a card that is merged or closed, however recent its last pulse; the bus reader behind the board also gives each card its stage (planned, in work, review, answer/changes, ready, merged, stopped, dropped) from its open task in the bus queues, else from its state, counts the cards of the release the goal names by stage, and lists what waits for the owner — an open owner question, an owner-only merge denial on an open pull request, and an open pull request that no card owns
