---
'mikoshi-construct': patch
---

Internal: `THRESHOLDS` and `StopReason` are declared in the session's `eddies-measure`, with `role` and `exit` re-exporting them, and the six review and close queue readers (`reviewCandidates`, `closeCandidates`, `reviewsOfAnOldInput`, `reviewsOfTheCurrentInputAgain` and their two key readers) move from the bus queue to the session's `derive-queues`. The review and close nodes take them already bound to their rules from the composition root. The ratchet row `session->window` falls from 2 to 1; no row grows. Behaviour is unchanged.
