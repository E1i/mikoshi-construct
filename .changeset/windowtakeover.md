---
"mikoshi-construct": patch
---

`pnpm bus:request takeover --card <N> --reason <text>` lets the window take the tree of a card the bus has no route for: a `question.owner` stop with no lift, green witnesses with no open pull request, or no answer or launch task for 30 minutes on a card that needs one. It is refused with the reason named while the card has a live task or a running session. An accepted takeover records `card.held` and `card.takeover`, the answer node skips the card, and `release --card <N>` ends it and queues again the answer tasks the hold withdrew.
