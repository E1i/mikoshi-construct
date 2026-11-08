---
'mikoshi-construct': patch
---

A merge or witness task left on a pull request the owner merged no longer stays queued for good: the bus withdraws it unless a live lease is finishing the merge. A close task stays while its card is open, and so does a witness task on the base the card's close was denied on; both are withdrawn once the card is closed.
