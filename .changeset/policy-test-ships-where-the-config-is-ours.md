---
"mikoshi-construct": patch
---

The syntax-policy test ships only where the construct wrote `eslint.config.mjs`. It had been moved into
each preset's `baseline` so it would reach a repository that already has code, but `eslint.config.mjs`
is `baseline` too and an existing one is never overwritten — so the test landed next to an owner's
configuration and asserted the construct's selectors against it. Against a repository whose policy is
deliberately narrower, every form the narrowing skips reads as a restriction that failed to fire, and
`pnpm run quality` fails immediately after `init` on a configuration that is not wrong. No guard fixes
that: a test deriving its expectations from the resolved selectors asserts that what is declared is
declared, and a present-but-narrower policy is neither present-as-shipped nor absent.

The test returns to `sample` in node-backend, node-frontend and monorepo, unchanged in strength, and
node-backend's `sample` group entry is restored. A repository that keeps its own lint configuration
hears the same thing from `doctor`, which reports `lint-policy absent` with its evidence — the one
place that can tell the two situations apart — and `docs/cli.md` now says so and how an owner adopts
the policy deliberately.
