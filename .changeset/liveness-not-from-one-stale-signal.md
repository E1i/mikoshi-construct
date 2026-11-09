---
'mikoshi-construct': patch
---

The board page no longer reads `bus offline` while the launch node is running cards. The header used to look only at the window heartbeat. Now a card session that has beaten within the last few minutes also counts as live, so a stale supervise or window signal next to running card sessions no longer reads as a dead factory.
