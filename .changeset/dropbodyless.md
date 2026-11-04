---
"mikoshi-construct": patch
---

`pnpm bus:request drop --card <N> --reason <text>` drops a card the bus knows that has no admitted body and has not ended, so such a card no longer sits in review for ever raising a stall warning; a card with a body keeps the `pnpm intake --move` route.
