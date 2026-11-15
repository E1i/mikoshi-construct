---
'mikoshi-construct': patch
---

Registration happens only in `scripts/supervisor/composition.ts`, and lint holds it. `eslint.config.mjs` adds two rules. `composition/registers-only-in-composition` refuses, under `scripts/` outside the tests, any registration list the composition holds (today the projection lists `folds` and `incremental`), and everywhere refuses a registration at import time: such a list outside a function, a `register*` call, or a `push`, `unshift`, `splice`, `set` or `add` on a binding that is imported or exported. A script filling its own collection is not a registration. `composition/no-side-effects-on-import` keeps `composition.ts` to imports, types, functions and constant values. On current main neither rule reports anything, so no registration moves.
