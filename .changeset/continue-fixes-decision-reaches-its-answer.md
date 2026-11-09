---
'mikoshi-construct': patch
---

`pnpm decisions:add` refuses an `allow-merge` or `continue-fixes` record whose sha is not a full head the bus observed for that pull request, before anything is requested or said on the owner channel. Such a record was written without a word and never answered, because the bus reads it only at a full 40-hex head. When the short form is the prefix of exactly one observed head, the refusal gives the full record to write; otherwise it names the latest observed head, or says that more than one head matches or that none was observed.
