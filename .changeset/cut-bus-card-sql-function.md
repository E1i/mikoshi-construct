---
'mikoshi-construct': patch
---

The card grammar owns its SQL function: `registerCardFunctions(db)` in `src/card/grammar.ts` registers `card_blocks` on a database the bus opened, and the bus no longer imports the card grammar. Every root that opens the bus and reaches the inbox registers it after `openBus`.
