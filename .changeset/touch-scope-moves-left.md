---
'mikoshi-construct': patch
---

The rule that decides which paths a card may change now lives in one factory module that imports nothing from the CLI: which paths a text names, which fall outside the touches, which tests the runs cover, and which files follow the touches. The intake check, the card readers and the bus nodes all read it from there, and the factory manifest list moves with it, so the following table no longer names a manifest file of its own. The card version rises from 1 to 2: every new admission carries `cardVersion` 2, and a node of this build reads a card admitted at version 1 without a new admission.
