---
"mikoshi-construct": patch
---

Intake no longer reads a card that touches only `init` or its templates as risk R1: what `init` writes goes into the repository it creates, not into someone else's. What `attach`, `sync` or `detach` write into another repository stays R1.
