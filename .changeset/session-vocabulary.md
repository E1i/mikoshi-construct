---
'mikoshi-construct': patch
---

Internal: `THRESHOLDS` and `StopReason` are declared in the session's `eddies-measure`. `exit` re-exports `StopReason`; `role` neither declares nor re-exports `THRESHOLDS`, because a nodes file importing from the window contour breaks the layer rule `nodes-imports-nothing-to-its-right`. Instead `roleToOwner` takes the thresholds as a parameter, and the composition root binds them in `roleToOwnerAtTheThresholds`, which the restart worker calls. The six review and close queue readers (`reviewCandidates`, `closeCandidates`, `reviewsOfAnOldInput`, `reviewsOfTheCurrentInputAgain` and their two key readers) move from the bus queue to the session's `derive-queues`, and the review and close nodes take them already bound to their rules from the composition root. The ratchet row `boundary:session->window`, which was at 1, is removed; no row grows. Behaviour is unchanged.
