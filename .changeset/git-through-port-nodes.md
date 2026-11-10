---
'mikoshi-construct': patch
---

The answer, close, launch and review nodes now run git only through `scripts/ports/git.ts`: `answerer.ts`, `answer/duties/tree.ts`, `close-executor.ts`, `ended-card-trees.ts`, `lane-assign.ts`, `launch-root.ts`, `launch-starter.ts`, `tree-pr-cli.ts`, `depth-sources.ts` and `reviewer.ts` call `processGit` instead of spawning git themselves. Each call keeps its arguments and its error. A seal test, `scripts/tests/ports/git-seal-nodes.test.ts`, fails when a node calls git outside the port. The ratchet's `overlaps:git` goes down from 53 to 38.
