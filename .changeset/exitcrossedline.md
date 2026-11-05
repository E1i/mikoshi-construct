---
'mikoshi-construct': patch
---

`pnpm miko:exit` takes the context line this session crossed, by the hook's `budget-warn` record, as the context stop even after compaction shrank the context, and its refusal prints the context, the line and the source of each.
