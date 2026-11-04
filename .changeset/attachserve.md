---
"mikoshi-construct": patch
---

cli: `construct attach` takes `--serve "<command>"` and `--serve-url <url>` and records them as `serve` in `.construct/attach.json`, with the default `readyTimeoutMs` of 30000; it still writes no `construct.json`, and one flag without the other fails before anything is written. The bus's witness node reads `serve` from `construct.json` at the head or from the attach record through one reader, so a browser witness runs in an attached repository too; a repository with neither is still refused.
