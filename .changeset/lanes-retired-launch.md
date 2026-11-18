---
'mikoshi-construct': patch
---

Launch no longer needs a lane. An admitted card with no lane is launchable: the launch node selects it by its start order and its depends, holds it only on a touches overlap, an unmerged dependency or a full machine, and starts it. A card that still carries a lane launches as before.
