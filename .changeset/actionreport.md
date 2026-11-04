---
"mikoshi-construct": patch
---

On GitHub Actions `pnpm test` and `pnpm run quality` now pass vitest `--reporter=default --reporter=github-actions` explicitly, unless the command names a reporter of its own, so each failing test is a check annotation readable through `api.github.com` from any workflow that runs them.
