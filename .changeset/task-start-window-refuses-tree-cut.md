---
'mikoshi-construct': patch
---

`task:start` in a window now refuses before it touches git and names `pnpm bus:request tree.cut --card <N>`, the one way a window gets a tree; the bus's own cuts keep working, even from a bus a window raised. A `git worktree add` that fails removes the branch it created, so a refusal that says nothing was written holds.
