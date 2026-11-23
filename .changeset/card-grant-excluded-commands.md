---
'mikoshi-construct': patch
---

A row of the card grants table now carries `excludedCommands`, and a card session's `--settings` puts its row's exclusions into `sandbox.excludedCommands` beside the installed daemons' commands. Card #2156 runs `codex exec *` outside the sandbox by the owner's decision; no other card's settings exclude anything from the table.
