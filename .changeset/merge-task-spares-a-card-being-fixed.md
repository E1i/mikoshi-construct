---
'mikoshi-construct': patch
---

The merge node no longer faults a card that its answer is fixing. Before, a merge task stayed queued after the review verdict on its head turned to changes. Each retry counted as a failure, and the third one stopped the card as a fault while the answer session was still fixing it. Now the merge task is withdrawn without a failure and waits for the new head the answer brings. A head with no verdict yet is still retried as before.
