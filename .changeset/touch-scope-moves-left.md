---
'mikoshi-construct': patch
---

The rule that decides which paths a card may change now lives in one factory module that imports nothing from the CLI: which paths a text names, which fall outside the touches, which tests the runs cover, and which files follow the touches. The intake check, the card readers and the bus nodes all read it from there. No behaviour changes.
