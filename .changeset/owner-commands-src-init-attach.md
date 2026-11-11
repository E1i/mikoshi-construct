---
'mikoshi-construct': patch
---

`init` and `attach` take the command lines they print from `scripts/core/owner-commands.ts`: the default harness command and the `npx mikoshi-construct attach` rerun line come from the owner, and their rows leave the pending table. The text either writes is unchanged.
