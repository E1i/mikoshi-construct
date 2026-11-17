---
'mikoshi-construct': patch
---

A session stop that names `contract/factory.json` outside a card's touches no longer holds the card's launch. That file is a generated twin, which intake already removes from touches, so it now counts as covered. Before, launch kept releasing the card until the owner closed the wait by hand.
