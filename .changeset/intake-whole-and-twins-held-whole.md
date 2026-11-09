---
'mikoshi-construct': patch
---

Intake no longer proposes slices for a card whose draft states `whole:`: the complexity, volume and risk seams print no `slice:` lines for it, a `held whole:` line says that `--confirm` parks it as one card, and its risk seam alone no longer holds it for confirmation. A lock file (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` and the like) is grouped with the `package.json` or `pnpm-workspace.yaml` in its directory or below it, and a lock file with no manifest among the touches rides with another touch, so no slice is ever just the lock file.
