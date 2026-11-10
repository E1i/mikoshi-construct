---
'mikoshi-construct': patch
---

`scripts/core` runs no git and imports no `child_process`: each node's composition reads the code sha through `scripts/ports/git.ts` and hands it to `runNode`, and the callers of the push policy hand `pushPolicyOf` the port's reader.
