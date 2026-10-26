---
"mikoshi-construct": patch
---

factory: a card's tree under the old `~/.construct/worktrees/mc-<id>` path now belongs only to the bus that made it. A second bus no longer takes that tree for its own card with the same number: it cuts `<bus>/worktrees/<id>`, unless its own `card.started` for that card names the old path. The original machine bus at `~/.construct/bus.db` keeps the old trees of the cards it already started.
