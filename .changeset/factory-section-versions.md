---
'mikoshi-construct': patch
---

`contract/factory.json` versions its bus, card, ports and nodes sections, and `pnpm contract:bump` is red when a section changes without its version growing.
