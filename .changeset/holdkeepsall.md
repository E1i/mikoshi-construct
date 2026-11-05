---
'mikoshi-construct': patch
---

A card under `card.held`, a takeover included, now stays out of the launch candidates, its pull request is denied by the merge node as held, naming the hold's reason, and a session of it that exits at a boundary is neither continued nor restarted, until `card.released`; all of them go on after it with no new request. A continuation now waits while an admission of the card has not folded, and then runs on the new body.
