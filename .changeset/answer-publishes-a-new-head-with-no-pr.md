---
'mikoshi-construct': patch
---

A card that stopped before its pull request and is answered with a new commit is now published: the answer node runs tree-pr for it, links the pull request it opens and the card goes to review. Before, only an answer that left no new head was published, and a card answered with a new commit stood with its branch pushed, no pull request and no task.
