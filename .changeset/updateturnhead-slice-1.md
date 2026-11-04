---
"mikoshi-construct": patch
---

A pull request that holds the update turn and is green and clean now merges without waiting for the hold to expire. A lower pull request the merge queue sends for an update while another holds the turn waits until that hold ends, instead of being leased again every few seconds and keeping the holder out of the queue, which also spends fewer GitHub calls. Its update still comes as soon as the holder merges or loses the turn.
