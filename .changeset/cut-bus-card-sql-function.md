---
'mikoshi-construct': patch
---

The card grammar owns its SQL function: `registerCardFunctions(db, name)` in `src/card/grammar.ts` registers `card_blocks` on a database the bus opened, and the bus no longer imports the card grammar. The composition root registers it (`composeBus`, `openComposedBus`) for every process root that reaches the owner inbox, and `pnpm bus:inbox` now runs from `scripts/owner/inbox.ts`, which opens the bus through the composition.
