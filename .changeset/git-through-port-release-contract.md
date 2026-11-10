---
'mikoshi-construct': patch
---

The release and contract scripts now run git only through `scripts/ports/git.ts`: `contract/bump.ts`, `contract/declared.ts`, `contract/json-samples.ts`, `contract/surface.ts`, `release/changesets.ts`, `release/evidence.ts` and `release/security-diff.ts` call `processGit` instead of spawning git themselves. Each call keeps its arguments and its outcome. A seal test, `scripts/tests/ports/git-seal-release-contract.test.ts`, fails when a release or contract script calls git outside the port. The ratchet's `overlaps:git` goes down from 38 to 27.
