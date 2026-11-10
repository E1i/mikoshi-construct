---
'mikoshi-construct': patch
---

`construct intake --admit` and `--amend` keep the owner's order: a readmission of an admitted card whose text carries no `priority:` line keeps the priority of the card's latest admission, so the launch node no longer reads it as none. An amend takes a priority edit (`p0`, `p1`, `p2`, or `none`, the only way to clear it). A priority-only amend is not a new card body: the launch node does not restart a live session on it, and answer and merge tasks keyed on the body stay.
