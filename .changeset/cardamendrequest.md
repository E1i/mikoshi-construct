---
'mikoshi-construct': patch
---

A card is amended with no file: `pnpm bus:request amend --card <N>` adds and removes witnesses and touches, appends the owner's words verbatim and changes depends, the bus edits the body, recomputes its risk and runs, runs the lane check and keeps the card in its lane. `construct-intake --amend` recomputes the risk and runs the same way, and `--touches` and `--creates` take `+a,+b`, `+a +b` and the repeated flag alike, so no form drops a path.
