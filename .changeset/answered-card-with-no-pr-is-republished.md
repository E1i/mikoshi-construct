---
'mikoshi-construct': patch
---

A card already answered with a pushed head and no pull request is now published by the bus: the answer node finds it, runs tree-pr for it once, links the pull request it opens and the card goes to review. Before, such a card stood with no route and the window opened its pull request by hand. A card with a pull request, a dirty tree, a live task or an open owner wait is left as it is; a publish that opens no pull request stops the card for the owner instead of trying again.
