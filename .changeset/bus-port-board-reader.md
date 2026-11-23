---
'mikoshi-construct': patch
---

The board reader takes a read-only `BoardBus` handed in by the board command's root instead of opening a bus file itself; what the board prints does not change.
