---
"mikoshi-construct": minor
---

sync: `construct.json` moves to manifest version 6 (decision 0032). Every write of a block target (`AGENTS.md`, `CLAUDE.md`, `.gitignore`) by `init` or `sync --apply` now records the sha of the construct block's owned view and a snapshot of the vars it was written with. With these, `sync` reads such a target as `block-edited` (the block differs from what was written), `record-vars-edited` (the block is what was written but `vars` in `construct.json` changed since), `template-moved-on` (both as written, today's template renders differently; `--apply` writes it) or `keep`. A record cut before version 6 is never back-filled: where it reads `unknown`, sync says the record predates the fields that would answer, and running the construct again records them. `sync --json` gains the count keys `block-edited`, `record-vars-edited` and `template-moved-on`.
