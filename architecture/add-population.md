# The `add` population

The paths `planMaterialize` produces, partitioned into the kinds that decide whether a path can misfit
a tree that adopts the construct. This document states the partition as it stands now and changes
whenever a template does; `tests/add-population.test.ts` reads it as the second reader of the set the
code produces, in both directions — every produced path is classified here, and no path is named here
that the presets do not produce. The population was first named in the observation
[The `add` population, named before anything is done about it](observations.md#2026-09-21--the-add-population-named-before-anything-is-done-about-it),
which records the counts as they stood on its date.

**The population, partitioned.** Across the four available presets, `planMaterialize` produces 88
distinct paths. 37 of them are reached only in an empty directory, through a mount marked
`onlyWhenEmpty`. The remaining 51 are written into any tree that adopts the construct, and they fall
into four kinds:

`construct-subject` — the construct's own material, which cannot misfit because the construct is what
it describes: `.claude/agents/architect.md`, `.claude/agents/harness.md`,
`.claude/agents/implementer.md`, `.claude/commands/construct-discover.md`, `.claude/commands/plan.md`,
`.claude/rules/conventions.md`, `.claude/rules/css.md`, `.claude/rules/secrets.md`,
`.claude/rules/tests.md`, `.claude/skills/implement/SKILL.md`, `.github/workflows/security.yml`,
`.gitignore`, `.gitleaks.toml`, `AGENTS.md`, `CLAUDE.md`, `architecture/checklists.md`,
`architecture/decisions/README.md`, `architecture/principles.md`,
`architecture/security-invariants.md`, `scripts/construct/check-acceptance.mjs`, `scripts/construct/implement.workflow.mjs`.

`harness-adoption` — presumes the repository runs the construct's harness, and is inert or wrong
where it runs another: `.editorconfig`, `.github/workflows/ci.yml`, `.nvmrc`,
`.vscode/settings.json`, `eslint.config.mjs`, `package.json`, `pnpm-workspace.yaml`,
`scripts/composition/check.ts`, `scripts/composition/files.ts`, `scripts/composition/model.ts`,
`scripts/composition/render.ts`, `scripts/composition/sync-docs.ts`,
`scripts/tests/composition/files.test.ts`, `scripts/tests/composition/model.test.ts`,
`scripts/tests/composition/render.test.ts`, `tsconfig.base.json`, `tsconfig.json`,
`vitest.config.ts`.

`layout-or-stack-assumed` — asserts a directory layout or build shape the repository may not have:
`packages/shared/package.json`, `packages/shared/src/index.ts`,
`packages/shared/tsconfig.build.json`, `packages/shared/tsconfig.json`, `tsconfig.build.json`.

`contract-bound` — reached only where the chosen preset materializes an HTTP contract:
`.github/workflows/api-contract.yml`, `contracts/api/openapi.yaml`,
`packages/shared/src/api/openapi.ts`, `redocly.yaml`, `scripts/contracts/types.mjs`,
`scripts/tests/contracts/security.test.ts`, `src/contracts/openapi.ts`.

**Where a misfit can occur.** Of the five kinds, two are already conditional — `sample-only` on the
tree being empty, `contract-bound` on the preset chosen — and one, `construct-subject`, cannot misfit.
So the population where a misfit can occur is exactly `harness-adoption` and
`layout-or-stack-assumed`, plus the keys merged into `package.json`. A key merged into `package.json`
is not a path: `sync` classifies that file through `merge-json`, so such a misfit arrives as an added
key on a path classified `update` rather than as an `add`. **The applicability question has two
granularities, and only one of them is a file.**

**What it would take for `add` to decide otherwise.** Nothing in the current model can express it: a
fact about the tree would have to be available at classification time, and `classifyPath` is given
only the target, the recorded sha, the present content and the produced content. Whether that fact
should come from `detect` — which reports facts and never interprets
([decision 0015](decisions/0015-interpretation-stays-with-the-agent.md)) — or from the preset
declaring a precondition per path, is not settled here.
