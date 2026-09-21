---
"mikoshi-construct": patch
---

The written count says which of two questions it answers

`init` printed "Written: 4 files" and no next step in the same run. Both were right and they counted
different things: the count was applied write operations, the next step was derived from the
operations whose content actually differed from what was on disk. On a second run the merges and
appends reproduce what is already there, so four operations are applied and nothing changes — and the
reader was left reconciling two numbers that answer different questions under one word.

The row now names both: `59 files, 59 changed` on a first run, `4 files, 0 changed` on a second, `5
files, 1 changed` where one file was restored. The count is not removed, because the four operations
did happen. The changed set is now computed once and read by both the count and the next step, so
they cannot drift apart again.

The three cases of the closing line are unchanged.
