---
'mikoshi-construct': patch
---

cli: a release that lands after the answer node read the hold and before it withdrew the answer task no longer strands that task: the answer node queues it again once it finds the hold closed, as the release itself does for a task withdrawn before it.
