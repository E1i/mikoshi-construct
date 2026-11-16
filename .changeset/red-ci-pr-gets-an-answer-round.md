---
'mikoshi-construct': patch
---

A pull request whose CI is red on its own head now gets an answer round even while a card it depends on is still unmerged. Before, the dependency hold filtered the red-CI answer out too, so such a pull request waited for nobody: review waits for green CI, and no answer was queued. The unmerged dependency still holds the merge and the update, and the answer round never merges the dependency in.
