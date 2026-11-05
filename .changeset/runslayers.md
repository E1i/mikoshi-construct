---
'mikoshi-construct': patch
---

A card's `runs` field now also takes `layer:<id>`, a layer of `scripts/core/layer-map.json` that stands for the tests of that layer: an id the map does not hold is refused, and a card with no `layer:` entry parses as before.
