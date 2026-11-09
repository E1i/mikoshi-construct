---
'mikoshi-construct': patch
---

`pnpm decisions:add` refuses an `allow-merge` or `continue-fixes` record whose sha is not a full observed head of its pull request and names the full head, and `pnpm handoff:write` accepts `STATUS: OWNER — boundary: round-limit` under a decisions shard.
