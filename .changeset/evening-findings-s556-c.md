---
'mikoshi-construct': patch
---

One supervision for card and answer sessions. A window start ends with its window session, so a later takeover is no longer refused by a start that never ends. `bus:run` sweeps the leased launch and answer tasks: a session with no push and no context change past 30 minutes is closed and queued again when its process is gone, and raises one `session.stalled` event with its reason while it lives. The pid check of a recorded worker moved from `review-bg.ts` to `recorded-worker.ts`, and the launch node reads a card session whose recorded pid is gone as ended. An answer round merges main into the card tree before its session through the update node's merge, and a conflicting merge leaves the tree as it was and goes the update node's conflict path. A pull request the update node brought up to date with main is queued for merge without a window step.
