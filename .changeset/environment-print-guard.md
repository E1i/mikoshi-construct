---
'mikoshi-construct': patch
---

The Bash guards refuse a command that prints the whole environment: bare `env`, `printenv`, `set`, `export`, `export -p`, and any word naming `/proc/<anything>/environ`. Check a variable with `test -n "$VAR"`. An init repository gets the refusal through `scripts/construct/eddies.mjs`, an attached repository through `.construct/commit-guard.mjs`; an older install has it after `construct sync`.
