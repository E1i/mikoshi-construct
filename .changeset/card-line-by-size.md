---
'mikoshi-construct': patch
---

A card session now stops at the line of its card's size: `cardContextLineBySize` in `.claude/eddies.json` gives XS, S and M 150k and L 500k, and `cardContextLine` stays as the line of a session whose size is unknown. The session carries the size in `CONSTRUCT_CARD_SIZE`, an L session compacts above its line, and the board reads each card under its own line.
