---
'mikoshi-construct': patch
---

The launchd agent `construct-factory` installs now runs `/usr/bin/env construct-factory` and finds node and the supervisor each time it starts, so upgrading the package or node no longer breaks an installed factory. Run `construct-factory` once in each repository to rewrite an agent an earlier version installed.
