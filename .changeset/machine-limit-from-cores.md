---
'mikoshi-construct': patch
---

The machine's session limit now has a default: with no valid `limit.json`, a machine runs a quarter of its cores in sessions, at least one, instead of running without a limit. A session's vitest workers are at most cores divided by that limit, so a lone session on 16 cores with limit 4 gets 4 workers, not 15.
