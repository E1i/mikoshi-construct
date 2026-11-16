---
'mikoshi-construct': patch
---

cli: `miko:watch` wakes the window on a stalled session and on a release loop: `session.stalled` now returns `miko:watch --once` with its line, as `board.alarm` already does; and a task released three times in a row with the same reason wakes the watch once with one line naming the card, the queue, the reason, the count and the first release time. Two releases do not wake, a different reason or a completed lease resets the count, and later releases of the same run stay silent.
