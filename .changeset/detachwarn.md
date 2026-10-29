---
"mikoshi-construct": patch
---

`construct detach` no longer removes silently. Before anything goes it prints what it will take — each daemon run directory under `.construct/daemon`, the factory's directory beside the repository with its handoff, the handoff's archive and the owner decisions, each with its number of paths, and the total — and asks for confirmation. `--yes` prints the same list and removes without asking; without a terminal and without `--yes`, detach removes nothing and exits `1`.
