---
"mikoshi-construct": patch
---

A card tree now lives under its own bus directory, `<bus directory>/worktrees/<card>`, so card 2 of two different buses gets two different paths. A card whose tree already exists at `~/.construct/worktrees/mc-<card>` keeps it until it ends, and `CONSTRUCT_WORKTREE_HOME` still overrides the root when set.
