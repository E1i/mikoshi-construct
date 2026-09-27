---
"mikoshi-construct": patch
---

cli: with a harness command the user named, `construct.model.json` no longer claims what that command runs. `every-change-passes-the-harness` states `<command> passes on every change` with no verification when the harness is not `pnpm run quality`, instead of always claiming lint, typecheck and tests pass with an ESLint verification it cannot know holds; `lint-policy` is not born at all, since it names a pnpm script and a test file the harness command may not run.
