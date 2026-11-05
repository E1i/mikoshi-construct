---
'mikoshi-construct': patch
---

A `shard.decided` from the answer node now carries the decision text, and the session receives that text; a question with no decision text is refused and held for the window instead of coming back to the session unchanged.
