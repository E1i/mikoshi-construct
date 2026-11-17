---
'mikoshi-construct': patch
---

The board no longer drops a card session from SERVICES while it runs a long command. A session that started and has not ended stays on the board whatever the age of its last heartbeat; when nothing has beaten for ten minutes its line reads `WAITING · NO PULSE <n> min` instead of disappearing. The launch node's `card.pulse`, written every five minutes while the session's process is alive, now counts as that session's beat, so a session inside a 29-minute test run reads live.
