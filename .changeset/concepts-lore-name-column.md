---
'mikoshi-construct': patch
---

Each concept in `contract/factory.json` now carries a `lore` column, the in-universe name it holds, or `null`. Generation fails when two concepts hold the same lore name, so one lore name can no longer cover two different things.
