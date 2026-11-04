---
"mikoshi-construct": patch
---

A pull request opened without a card line in its description is no longer cut off from its card. The bus now records each pull request's head branch in `pr.observed` and `pr.closed`, and when a newly observed pull request names no card, it links it to the one card whose body declares that branch, so review, answer, CI and merge reach the card. A branch that matches no card, or the branches of two cards, leaves the pull request unlinked rather than guessed, and a card line in the description always wins over the branch.
