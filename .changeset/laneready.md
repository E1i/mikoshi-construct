---
"mikoshi-construct": patch
---

A ready card no longer waits behind a not-ready card of its lane when another lane is empty. When a chain of not-started cards holds a card that cannot start, the ready cards that no such card precedes and that overlap no running card or open pull request move to the empty lane as a chain of their own, and the not-ready cards stay; launch's overlap check holds the later card back while the one that moved runs. A not-ready card keeps its parent in the lane, a ready card whose touches overlap a ready card stays with it, and a lane the owner set with a move is not reflowed.
