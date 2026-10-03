---
"mikoshi-construct": minor
---

templates: a browser witness carrier, `scripts/construct/browser-witness.mjs`, starts a dev server on a free port, opens its pages in system Chrome at the widths asked for, and exits 0 when every assertion holds, 1 when one is false and 127 when it could not observe (`could not observe: …`) or was called wrongly (`usage error: …`); `init` and `attach` write it
