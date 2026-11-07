---
'mikoshi-construct': patch
---

Every port in `contract/factory.json` now records which language it speaks: `factory` when its exported surface names only the factory's own words, `technology` when it names a technology such as `git`, `gh`, `lsof` or `stdout`, with those words listed in `technologyWords` so a reader can check the mark.
