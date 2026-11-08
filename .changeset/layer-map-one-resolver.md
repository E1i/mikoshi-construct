---
'mikoshi-construct': patch
---

Which layer a file belongs to has one answer, `scripts/core/layer-map.ts`, and the CI selector, a card's runs and the check catalog read it from there. Architecture and docs pages, skills, commands and `README.md` get a `docs` layer whose tests are the ones that read them, a new test file not yet in the graph runs itself, and a code file in no layer still runs the full suite.
