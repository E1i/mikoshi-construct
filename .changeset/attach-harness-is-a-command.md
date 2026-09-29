---
"mikoshi-construct": minor
---

cli: attach refuses a harness whose first word is not a command on PATH (a script name such as `quality`, or `vitest` from `node_modules/.bin`) and prints the command to use instead, and warns when the harness edits files (`:fix`, `--fix`, `--write`)
