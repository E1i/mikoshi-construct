---
"mikoshi-construct": minor
---

templates: the `/implement` ladder's outcome is now `untested change` — never `done` — for a rung that changed a source file (a path with a `src/` segment ending in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs`, not `.d.ts`) and no test file (a path with a `tests/` segment named `*.test.` with one of those extensions); the attempt's reason names the source files, and the run goes on to the next rung. A red harness, an unchanged tree, an immutable path and an unwitnessed acceptance keep their own outcomes.
