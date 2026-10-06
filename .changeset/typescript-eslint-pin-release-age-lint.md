---
"mikoshi-construct": minor
---

templates: a generated project pins every typescript-eslint package to 8.71.0 in `overrides`, because 8.71.1 reports false `no-unused-vars` "only used as a type" errors (typescript-eslint#12980), and declares `minimumReleaseAgeExclude` as a block list after `minimumReleaseAgeExcludePrune`, holding the already-mature `why-is-node-running@3.2.1`, so the entries pnpm adds for a dependency younger than a day land where the project's own lint accepts them; the override is removed once a release closing typescript-eslint#12980 is older than a day
