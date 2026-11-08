---
'mikoshi-construct': patch
---

cli: `owner.wait.close` without `--from answer` is now refused unless it records a decision under a live decisions shard, so a window can no longer close an owner wait without the owner's word.
