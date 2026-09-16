---
description: Discover this repository and fill the construct's discovery markers — the step that turns a materialized baseline into a project-specific workflow.
argument-hint: [area to (re)discover, or empty for everything]
---

You are running construct discovery. The CLI detected facts (`construct.json`); your job is to
interpret the system and record what an agent must know to work here safely. Write nothing you did
not verify by reading code; where the codebase is inconsistent, record an open question instead of
inventing a rule.

Scope: `$ARGUMENTS` (empty means every marker). The markers, and the file each one lives in, are
listed under `discovery` in `construct.json`. Every marker is a block between
`<!-- construct:discover:<name> -->` and `<!-- /construct:discover:<name> -->`; replace the placeholder
line inside the block and nothing outside it. `construct doctor` reports any marker still holding the
placeholder.

Work in this order:

1. **Inventory.** Read `construct.json`, `package.json`, the directory tree two levels deep, the entry
   points (`src/server.ts`, `src/app.ts`, CLI scripts, workers), the API contract and every
   `*.config.ts` / `config.ts`. Note the package manager, runtime, database and clients, CI, deployment
   and existing conventions. Do not write yet.
2. **`product`** (AGENTS.md): what the system does, in one paragraph, and the one flow where a
   defect costs the most (money, identity, data). If the repository is empty apart from the baseline,
   say so in one line.
3. **`module-map`** (CLAUDE.md): a table `Path | Purpose` of the top-level modules that exist. Only
   what exists.
4. **`commands`** (CLAUDE.md): dev, build, test and operational scripts from `package.json` that the
   baseline block above does not already list, one line each. Remove the placeholder if there are none.
5. **`composition-roots`** (CLAUDE.md): the files where services are constructed and routes, jobs or
   handlers are mounted, and the rule for adding a new one.
6. **`dependency-policy`** (CLAUDE.md, and `eslint.config.mjs`): which modules or packages may import
   which. Describe it in one paragraph and make sure `eslint.config.mjs` enforces it — extend the
   `dependencyPolicy` block there; a declared policy that lint does not enforce is not a policy.
7. **`high-effort-areas`** (CLAUDE.md): the paths where a wrong low-effort guess is expensive —
   attribution, authentication, money, schema, anything a shipped client depends on. This list is what
   `/implement` uses to classify a task as `high`.
8. **`composition`** (`architecture/composition/*.yaml`): one model per real flow the code has today
   beyond the baseline `http.yaml` (a worker, a sync, a CLI) — small, one per flow, every `path` must
   exist. Add a `doc:` markdown with the `<!-- composition:<id> -->` block, run
   `pnpm composition:render`, and confirm `pnpm composition:check` passes. Update `http.yaml` when the
   HTTP composition root has grown past the baseline.
9. **`security-invariants`** (`architecture/security-invariants.md`): rows in the form
   `Invariant | Enforced by` for the system-specific invariants — ownership checks, role middleware,
   integer money, closed DTOs. Name the lint rule, test or scanner that enforces each; write `review`
   only when nothing mechanical exists yet, and prefer adding the check to writing the word.
10. **`defects-vs-variance`** and **`open-questions`** (AGENTS.md): what a reviewer must flag here
    beyond the baseline list, and what looks like a convention but is not consistently applied.
11. **Prove it.** Run the harness command from `construct.json`. Fix anything discovery broke (a
    stale rendered diagram, a lint rule with no matching file). Then run `construct doctor` if the
    CLI is installed, or check by eye that no marker still holds the placeholder.

Report: which markers you filled, which you left as open questions and why, and the harness result.
Do not commit.
