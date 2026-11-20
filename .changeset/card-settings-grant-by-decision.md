---
'mikoshi-construct': patch
---

A card session can be granted extra Bash rules, outbound hosts and writes under the home directory by an owner decision, through one grants table in `scripts/ports/card-grants.ts`. The session settings add exactly the row of their own card and nothing to any other card. The one row is card #2156 by D-705: `codex`, `git init` and `mkdir` under `$TMPDIR`, the hosts of the Codex API and of its ChatGPT sign-in, and a write to Codex's home directory.
