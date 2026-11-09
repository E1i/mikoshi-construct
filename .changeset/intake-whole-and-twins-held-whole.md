---
'mikoshi-construct': patch
---

Intake no longer proposes slices for a card whose draft states `whole:`: the complexity, volume and risk seams write no `slice:` lines for it, and its risk seam alone no longer holds it for confirmation. When other cards of the run wait for confirmation, a whole card is not listed under Held: it prints one line, `Whole: <card> (whole: <reason>)`, with no `seam:`, `slice:` or `risk:` lines under it. A lock file (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` and the like) is grouped with the `package.json` or `pnpm-workspace.yaml` in its directory or below it, and a lock file with no manifest among the touches rides with another touch, so no slice is ever just the lock file.
