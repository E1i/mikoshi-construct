---
'mikoshi-construct': patch
---

A card that drops an import may now delete the entry of `.dependency-cruiser-known-violations.json` that the import made stale, without that file in its touches (D-514). The answer round, the review and the merge let the file follow the touches only when the change removes entries and adds or alters none; the merge reads that from the pull request's patch and the file at its head. A grown or altered list stays outside the touches: the answer node still drops it and sends the answer back, and the merge still refuses it.
