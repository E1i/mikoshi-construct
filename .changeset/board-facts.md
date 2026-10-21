---
"mikoshi-construct": patch
---

cli: `construct board` gives each card its stage (planned, in work, review, answer/changes, ready, merged, stopped, dropped) from its open task in the bus queues, else from its state, and the Backlog prints that stage; the goal line reads `merged N/M` followed by the count of the goal's cards in each open stage; a `waits for you` line under it lists an open owner question, an owner-only merge denial on an open pull request and an open pull request that no card owns, and is absent when nothing waits; Services shows a session only while it is live — its card is not merged or closed, its step is the card's current stage, and its last pulse is at most 10 minutes old
