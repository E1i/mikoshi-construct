---
"mikoshi-construct": patch
---

An answer session that merges `origin/main` into the card branch, or rebases the branch onto it, no longer has its card stopped with a false question about paths outside the card's touches. Before, the bus answer node counted every path committed since the remote head of the branch. After a merge or rebase, that range included main's own commits, so main's files counted as the answer's changes. Now the node counts the paths the branch changes against its merge base with `origin/main`, plus the uncommitted ones. A path the answer itself changes outside the touches is still refused.
