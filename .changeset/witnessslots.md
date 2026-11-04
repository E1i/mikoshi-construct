---
"mikoshi-construct": patch
---

The witness node now witnesses two heads at once: its executor no longer blocks the event loop while a witness command runs, and the git fetch and worktree setup of its tasks take turns, so two tasks never run them together.
