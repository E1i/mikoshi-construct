---
'mikoshi-construct': patch
---

Every port in `contract/factory.json` now records which language it speaks: `factory` when its exported surface names only the factory's own words, `technology` when it names a technology such as `git`, `gh`, `lsof` or `stdout`, with those words listed in `technologyWords` so a reader can check the mark. The generator keeps no list of technology words: each technology port declares its own in an exported `TECHNOLOGY_WORDS`, the client adapter contributes its id, and the generator only collects them, so a new word is added in its adapter alone.
