---
'mikoshi-construct': patch
---

bus: a pull request that conflicts with `main` and whose card tree stands mid-merge (a `MERGE_HEAD`, unmerged paths) now gets an answer round that finishes that merge where it stands: the session resolves and stages every unmerged path, never runs `git merge --abort`, `git reset` or a new merge over it, and the bus commits the tree, which concludes the merge, and pushes it. When the card tree cannot be read, the answer opens a named owner wait for the pull request instead of staying silent, and spawns no session.
