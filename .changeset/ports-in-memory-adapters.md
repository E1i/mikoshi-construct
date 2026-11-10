---
'mikoshi-construct': patch
---

The gh, worktree, session and snapshot ports each carry an in-memory adapter — `InMemoryGh`, `InMemoryTrees` with `InMemoryShell`, `InMemorySessions` and `InMemoryPulls` — that answers from a script and records its calls, so a test of a node behind those ports runs without spawning git, ps, gh or a client session.
