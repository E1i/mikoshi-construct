---
"mikoshi-construct": patch
---

On GitHub Actions `pnpm test` and `pnpm run quality` now name vitest's `default` and `github-actions` reporters explicitly, unless the command names a reporter of its own. Vitest 5.0.0 already defaults to `github-actions` there (`node_modules/vitest/dist/chunks/defaults.D2ip7f-X.js:67`), so annotations do not change today and this does not explain any run that lacked them; the flags keep them if that default changes.
