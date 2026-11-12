---
'mikoshi-construct': patch
---

The lore and plain lines in `src/ui/lore.ts` take the `construct` and `pnpm` command lines they name from `scripts/core/owner-commands.ts`; the row of `src/ui/lore.ts` leaves the pending table, and the ratchet's `overlaps:owner-commands` falls to its new minimum. The text of every line is unchanged.
