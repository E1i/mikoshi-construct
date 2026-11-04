---
"mikoshi-construct": patch
---

The answer node now opens the missing pull request of a card whose session committed and ended without one. An answer that leaves a clean tree with commits ahead of `origin/main`, on a card with no pull request in the bus, runs the same `tree-pr` step the launch node runs and is recorded as `card.answered` with `published: true`, and the card goes to review on the new pull request. A `tree-pr` that opens none leaves the denial `left_nothing` as before; a tree with uncommitted changes and a card that has a pull request are unchanged.
