---
'mikoshi-construct': patch
---

The boundary ratchet now finds the base of a pull request in CI. The vitest job checks out at depth 2, and on a pull request or merge-queue run whose HEAD is a merge commit the ratchet reads that commit's first parent as the commit the branch left from; outside CI it keeps the merge-base with `origin/main` or `main`. When neither is reachable and a boundary row grew, the check fails and names why, instead of reading no ownership move at all.
