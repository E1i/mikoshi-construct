---
"mikoshi-construct": patch
---

`pnpm miko:exit` at `STATUS: DONE` no longer ends a window whose owner has not written in it yet: the window waits for the owner's first message and takes its task. A subagent the window stopped with `TaskStop` no longer counts as running, so the exit is not refused for it. A window's heartbeat carries its repository, and a second window in the same repository names the first before it writes its own beat. The card-tree port cuts a tree for a branch that has no card, by the same path it cuts card trees.
