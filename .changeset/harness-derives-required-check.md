---
'mikoshi-construct': patch
---

cli: `attach --harness <cmd>` without `--required-check` takes the CI job whose step runs that command, and refuses with exit 2 when no such job is found.
