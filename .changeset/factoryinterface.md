---
'mikoshi-construct': patch
---

`contract/factory.json` now records the factory's own interface, generated from its code by `pnpm contract:update`: the signatures of every port, the bus events, payload keys, tables and `BUS_VERSION`, the concept-to-owner table, and per concept the files that implement it outside its owner with a count. `pnpm contract:overlaps` prints each of those sites as `file:line`, and a test fails when the recorded file differs from the generated one. Intake and the preflight treat the file as generated, as they treat `contract/surface.json`.
