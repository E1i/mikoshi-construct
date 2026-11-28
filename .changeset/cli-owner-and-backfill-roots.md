---
'mikoshi-construct': patch
---

Internal: `scripts/cli/card.ts`, `scripts/cli/mutate.ts` and `scripts/owner/session.ts` become composition roots in `COMPOSITION_ROOTS`. `scripts/cli/card.ts` leaves the `card-record` declaration and `scripts/cli/mutate.ts` leaves `quality`. The declarations check in `scripts/core/declarations.ts` now reads the composition roots from `contract/factory.json`, and a root that no module declares is no longer reported as unowned; any other unowned file still is. The ratchet rows `boundary:card-record->plan`, `decisions->session` and `quality->composition-root` fall to 0 and are removed. Behaviour is unchanged.
