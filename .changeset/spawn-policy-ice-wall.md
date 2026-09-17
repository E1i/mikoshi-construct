---
"mikoshi-construct": patch
---

The ICE was painted on, not wired: the invariant "the CLI spawns exactly one child process" was enforced by a single selector matching a static `import` of `node:child_process`, so `await import('node:child_process')` and `createRequire(target)('eslint')` walked straight through. The `spawnPolicy` block now fails the build on the whole class — any dynamic `import()` whatever its specifier, `require` calls and `require.*` access, `node:module` and `createRequire` — anywhere under `src/` except the pnpm version probe, and `tests/dependency-policy.test.ts` lints one real source sample per form instead of comparing selector strings. The invariants table now names the mechanism rather than the word `lint`.
