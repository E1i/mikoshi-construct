---
'mikoshi-construct': patch
---

Intake no longer admits `contract/factory.json` in a card's touches: it removes the entry and prints a correction, `touches — contract/factory.json → (removed) — …`, naming `scripts/contract/factory/*.ts` as the contract's source and the bus as the file's writer. After a card session ends, the shift runs `pnpm contract:update` in the card tree, when the tree carries `contract/factory.json`, and commits the rebuilt contract in the same commit as the sources that changed it, before the pull request opens. A session's own edit of the file is overwritten by that rebuild. When the bus merges a fresh `origin/main`, a conflict on the rebuilt files takes main's side and the contract is rebuilt again. A rebuild that fails opens no pull request and returns the card to its session once, with `twin-unbuilt`, to fix the sources.
