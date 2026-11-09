---
'mikoshi-construct': patch
---

The supervision of silent sessions now covers spend and review. A card or answer session whose Eddies journal records a session-spend stop is stopped by `bus:run`, with a `session.stalled` event whose reason names the spend and the limit. A review session that records no new step and no context growth for 8 minutes is ended at that point, not at its 20-minute ceiling; a live heartbeat alone does not count as progress. On a code restart a review worker that holds a lease finishes its rounds and exits, while the new worker takes the queued reviews in the free review slots. A test now drives a bus tick built by `composeBusTick` through the silent-session check. A card stopped by fault whose tree holds uncommitted changes now has a way back: `pnpm bus:request requeue --task <task_key> --keep-tree` queues its launch again and the session starts on that tree as it stands; without `--keep-tree` the refusal names this option.
