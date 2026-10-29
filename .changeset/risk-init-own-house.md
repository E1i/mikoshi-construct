---
"mikoshi-construct": patch
---

Intake no longer reads a card that touches only `src/commands/init.ts` as risk R1: what `init` writes goes into the repository it creates, not into someone else's. What `attach`, `sync` or `detach` write into another repository stays R1, including every template group and the `src/materialize` strategies they share with `init`.
