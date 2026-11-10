---
'mikoshi-construct': patch
---

The supervisor no longer ends a live review session because only its context reading stood still. It now reads three signals: context growth, transcript growth (the spend and subagent readings the heartbeat takes from the transcript), and the session's process pulse. A review is stopped only when two or more of them have stood still past the no-progress line. With a single stale signal the supervisor raises `session.stalled` with the reason and stops nothing. A review the stall line has already ended once on a head is not queued again the same way: the second time, its task is withdrawn as `review_stalled_twice`, and the window gets the reason with the other way to take, a review by slices of the diff.
