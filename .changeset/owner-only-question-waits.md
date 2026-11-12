---
'mikoshi-construct': patch
---

A card question asking a `contract/ratchet.json` row to grow now stops for the owner the first time it is asked (`card.stopped` `question.owner` with an open owner wait), not as an agent question the answer node keeps re-running. A reworded ask for the same row reuses the open wait and starts no answer session.
