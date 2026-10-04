---
"mikoshi-construct": minor
---

templates: `init` and `attach` also write `scripts/construct/check-baseline.mjs`, which runs every harness step even after a red one and prints, for each step, the eslint, Vitest, Jest or tsc failures it recognises (`null` when it recognises none) and the sha256 of the whole set; nothing calls it yet.
