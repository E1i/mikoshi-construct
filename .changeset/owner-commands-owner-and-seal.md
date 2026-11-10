---
'mikoshi-construct': patch
---

The command lines the owner is told to run have one owner, `scripts/core/owner-commands.ts`, which builds a `pnpm` or `construct` line from its parts; `src/` may import it. A seal test holds every file that still writes such a line itself to the count `scripts/tests/core/owner-commands-pending.json` records, so a new literal outside the owner fails the suite, and the next slices move their layer's lines into the owner and drop their rows.
