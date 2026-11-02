---
"mikoshi-construct": patch
---

A card's pull request in conflict with `main` now goes to the bus update node, which merges `main` into the card's tree. Where the conflicting paths lie outside the card's touches, the node takes `main`'s version, commits the merge and pushes, so the pull request runs CI again. Where a conflict lies inside the card's touches, the node aborts the merge and stops the card with `question.owner`. Before, no node took such a pull request, and only the owner could clear it. If the update node cannot merge, for example because the card's tree is gone or stands mid-merge, it records a `merge_refused` denial, and the answer node takes the conflict as before.
