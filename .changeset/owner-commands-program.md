---
'mikoshi-construct': patch
---

`src/program.ts` reads the `pnpm mutate judge` command in the `mutate judge --card` help text from its owner, `scripts/core/owner-commands.ts`, instead of spelling it out. The help text is unchanged. `src/program.ts` leaves the owner-commands pending list, and the `owner-commands` overlaps fall from 116 to 115.
