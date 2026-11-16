---
'mikoshi-construct': patch
---

The launch and answer prompts now tell a card session to give a heavy gate step a Bash timeout of 1800000 ms, the 30-minute cap the session is spawned with, instead of 600000. Before, the explicit 10-minute timeout overrode the cap, so a long pre-push run was cut at 10 minutes and the round hung open after its last turn.
