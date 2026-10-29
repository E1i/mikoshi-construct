---
"mikoshi-construct": patch
---

`init` now writes the files the factory reads: the `brief`, `review` and `scan` agents (the brief agent names the repository's bus handoff and the `/implement` line the approval needs), the `probe` skill, the `/status` and `/attached-discover` commands, a default `architecture/owner-merges.md` with the column «merges under a shard», and a «Who commits» section in `CLAUDE.md`. `init` in a git repository and `attach` create `owner-decisions.md` beside the repository's bus when it is not there, so `decisions:add` no longer refuses on a first decision.
