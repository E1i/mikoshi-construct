---
description: Discover this repository and fill the construct's discovery markers — the step that turns a materialized baseline into a project-specific workflow.
argument-hint: [area to (re)discover, or empty for everything]
---

You are running construct discovery. The CLI detected facts (`construct.json`); your job is to
interpret the system and record what an agent must know to work here safely. Write nothing you did
not verify by reading code; where the codebase is inconsistent, record an open question instead of
inventing a rule.

Scope: `$ARGUMENTS` (empty means every marker). The markers, and the file each one lives in, are
listed under `discovery` in `construct.json` (the text markers in `AGENTS.md`, the composition models
in the directory `discovery.composition` names). Every marker is a block between
`<!-- construct:discover:<name> -->` and `<!-- /construct:discover:<name> -->`; replace the placeholder
line inside the block and nothing outside it. `construct doctor` reports any marker still holding the
placeholder.

Two rules for a repository that already documents itself:

- **One source of truth.** If a block's content already exists elsewhere — a module map in
  `README.md`, review standards in `best_practices.md`, invariants a PR reviewer reads — the marker
  body is a pointer to that place (path and heading), not a copy. Do not duplicate, and do not merge
  the existing document into the construct's files unless the user asks.
- **Move nothing.** Existing composition models, docs and scripts stay where they are; `construct.json`
  already records where the models live. If a construct file links to a path that differs from the
  real one, say so in the report instead of renaming directories.

Work in this order:

1. **Wire the harness.** In a repository that existed before the construct, `init` kept the
   existing `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts` and `quality` script. Before
   anything else make them cover what the construct added: ESLint ignores
   `scripts/construct/*.workflow.mjs` (top-level `return`), TypeScript includes `scripts/**/*.ts`,
   Vitest includes `scripts/tests/**/*.test.ts`, and the harness command runs `composition:check`
   (and `contracts:check` when a contract exists). Then run the harness; it must be green before
   discovery starts. Skip this step when the construct created those files itself.
2. **Inventory.** Read `construct.json`, `package.json`, the directory tree two levels deep, the entry
   points (servers, app factories, `main.ts`, CLI scripts, workers), the API contract if there is
   one, and every `*.config.ts` / `config.ts`. Note the package manager, runtime, database and clients, CI, deployment
   and existing conventions. Do not write yet.
3. **`product`** (AGENTS.md): what the system does, in one paragraph, and the one flow where a
   defect costs the most (money, identity, data). If the repository is empty apart from the baseline,
   say so in one line.
4. **`module-map`** (AGENTS.md): a table `Path | Purpose` of the top-level modules that exist. Only
   what exists.
5. **`commands`** (AGENTS.md): dev, build, test and operational scripts from `package.json` that the
   baseline block above does not already list, one line each. Remove the placeholder if there are none.
6. **`composition-roots`** (AGENTS.md): the files where services are constructed and routes, jobs or
   handlers are mounted, and the rule for adding a new one.
7. **`dependency-policy`** (AGENTS.md, and `eslint.config.mjs`): which modules or packages may import
   which. Describe it in one paragraph and make sure `eslint.config.mjs` enforces it — extend the
   policy blocks there (`ALLOWED_WORKSPACE_IMPORTS`, the `restrictSyntax` rules); a declared policy
   that lint does not enforce is not a policy.
8. **`high-effort-areas`** (AGENTS.md): the paths where a wrong low-effort guess is expensive —
   attribution, authentication, money, schema, anything a shipped client depends on. This list is what
   `/implement` uses to classify a task as `high`.
9. **`composition`** (`<discovery.composition>/*.yaml` from `construct.json`): one model per real flow the code has today
   (the HTTP app, a worker, a sync, a CLI, the browser bootstrap) — small, one per flow, every `path`
   must exist. A baseline model, when the construct shipped one, is updated, not duplicated; a
   repository that had code before the construct starts with no model and needs at least one for its
   main entry point. Add a `doc:` markdown with the `<!-- composition:<id> -->` block, run
   `pnpm composition:render`, and confirm `pnpm composition:check` passes.
10. **`security-invariants`** (`architecture/security-invariants.md`): rows in the form
   `Invariant | Enforced by` for the system-specific invariants — ownership checks, role middleware,
   integer money, closed DTOs. Name the lint rule, test or scanner that enforces each; write `review`
   only when nothing mechanical exists yet, and prefer adding the check to writing the word.
11. **`defects-vs-variance`** and **`open-questions`** (AGENTS.md): what a reviewer must flag here
    beyond the baseline list, and what looks like a convention but is not consistently applied.
12. **Prove it.** Run the harness command from `construct.json`. Fix anything discovery broke (a
    stale rendered diagram, a lint rule with no matching file). Then run `construct doctor`, or
    `npx mikoshi-construct doctor` when the CLI is not installed; it names every marker that still
    holds the placeholder.

Report: which markers you filled, which you left as open questions and why, and the harness result.
Do not commit.
