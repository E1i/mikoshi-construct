---
'mikoshi-construct': patch
---

The answer node no longer drops an answer silently. Before, an answer that found a live session in the card tree was withdrawn as held for the owner, and nothing queued it again when that session ended. Now it waits and is checked again every five minutes, with no failure counted, and it runs once the session is gone. An answer leased for a review head that the pull request has since moved past is now superseded before any session runs. It writes no answer and spends no review round.
