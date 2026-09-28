# mikoshi-construct

CLI that materializes a **construct** — architecture policy, API contract, quality harness and AI-agent
instructions — into a repository, then hands the repository to the agent for discovery. This repository
runs on its own construct (see the Construct block at the end and [AGENTS.md](AGENTS.md)); the `init`
flow is modelled in [architecture/composition/init.yaml](architecture/composition/init.yaml). Never copy
project-specific names, scopes, env vars or webhooks from any reference repository into templates.

## Commands

```bash
pnpm dev init --yes --preset node-backend --dir /tmp/demo   # run the CLI from source
pnpm dev doctor --dir /tmp/demo
pnpm dev soulkill --dir /tmp/demo --json
pnpm run quality        # lint + typecheck + vitest — the gate for every change
pnpm build              # tsup → dist/cli.js (bin: construct, miko, mikoshi-construct)
```

Contract paths: contract/surface.json

Run the published CLI from outside this repository: `npx mikoshi-construct` here resolves the local
package, not the release. Keep the global `construct` current (`npm i -g mikoshi-construct@latest`):
a stale one reads a newer manifest as ahead of it, and its `cost` figures come from an older build.

Acceptance for any change touching `templates/` or `src/materialize`: an empty directory →
`construct init --yes --preset <preset>` → `pnpm install` → `pnpm run quality` is green, with no manual
edits. Run it before reporting done.

pnpm 12.4.2, the pinned `packageManager`, rejects `pnpm -s`; write `pnpm --silent` or `pnpm exec`.

## Layout

| Path | What it is |
|------|------------|
| `src/cli.ts` | Runs `main` from `src/program.ts` with citty's `runMain`; nothing else |
| `src/program.ts` | The citty command definitions and their aliases (`jack-in`, `jack-out`, `inspect`, `capture`), exported as `main` without running it |
| `src/detect/` | **Facts only** — package manager and installed pnpm version, layout, workspace packages, existing files. Never interprets the codebase |
| `src/presets/` | Preset = template groups (plain or mounted: `{ group, into, onlyWhenEmpty }`) + variables. `available: false` hides a preset from `init` |
| `src/materialize/` | `templates.ts` (walk, `_`→`.`, `.eta`→`{{var}}` + `{{#if}}` blocks), `plan.ts` (mount + layer groups → FileOp, canonical `package.json` key order), `strategies.ts` (create / merge-json / append-block, `preserveDiscovery`), `apply.ts` |
| `src/manifest.ts` | `construct.json`: preset, harness command, contract paths, file hashes, `DISCOVERY_MARKERS` |
| `src/failure.ts` | Turns a thrown error into one reading for the composition root: a `ManifestAheadOfReader` becomes the version-gap line, anything else its own message. Sits outside `src/ui/` because it needs both the error and the vocabulary, and the dependency policy keeps `src/ui` from importing the manifest |
| `src/commands/doctor/` | `index.ts` is the composition root; `baseline.ts` / `discovery.ts` / `harness.ts` keep the three verdicts (baseline intact, each discovery marker filled or named as missing, harness intact), `evidence.ts` and its readers do every read of the inspected repository, and `checks/*` turn that evidence into `{id, level, state, evidence}` — see [docs/cli.md](docs/cli.md) |
| `src/ui/` | `theme.ts` (arasaka / johnny / plain, `NO_COLOR`), `lore.ts` (all user-facing strings), `console.ts` (`createUi(theme, writer)`), `prompts.ts` (`Prompter` + the `@clack/prompts` implementation; `init` without `--yes` asks only for what flags left open) |
| `templates/base` | Stack-agnostic: `architecture/principles.md`, `checklists.md`, `security-invariants.md`, gitleaks, security workflow |
| `templates/harness` | Composition engine, contracts check scripts, eslint/tsconfig/vitest, `ci.yml`, `pnpm-workspace.yaml`, `package.json.eta` partial |
| `templates/stacks/<name>` | Sources shared by several presets, mounted at a path: `express-api/app` (the Express app, mounted at `.` or `apps/api`), `express-api/repo` (its composition model + pre-rendered doc), `http-contract` (OpenAPI, redocly, types script, security test, oasdiff workflow) |
| `templates/presets/<id>` | Stack-specific config. `baseline/` is always written; `sample/` (and mounted stacks marked `onlyWhenEmpty`) only into an empty directory — an existing repository gets policy and tooling, never example code |
| `templates/ai/shared`, `ai/claude`, `ai/cursor` | `AGENTS.md` and the rules (`shared/_claude/rules/*.md`, one source for both agents); `CLAUDE.md`, `.claude/` agents + skills + commands, `scripts/construct/implement.workflow.mjs` (the ladder script; it lives outside `.claude/` because Claude Code's permission classifier treats a Workflow script read from `.claude/` as self-modification, and the Workflow sandbox allows no `import()`, no filesystem and no bare `new Date()`) (claude); `.cursor/rules/construct.mdc` (cursor). `src/materialize/rules.ts` renders every `.claude/rules/*.md` in the plan to `.cursor/rules/*.mdc` for a Cursor target (`paths:` → `globs`, none → `alwaysApply: true`) and drops the `.claude` copy when the target is Cursor only. The discovery protocol `shared/_claude/commands/construct-discover.md` maps the same way to `.cursor/rules/construct-discover.mdc` (agent-requested, `$ARGUMENTS` rewritten). `ai/review` is the label-triggered `claude-review.yml`, added only with `--review claude` (`--review-model` fills `{{reviewModel}}`) |
| `scripts/contract/` | `surface.ts` generates the observable command-line surface (decision 0030); `update.ts` (`pnpm contract:update`) is the only writer of `contract/surface.json` |
| `contract/` | `surface.json`, the recorded surface; `tests/contract/` compares it with the generator and never writes it |
| `tests/` | Vitest: detect, strategies, init end to end (no install). `silentWriter` keeps stdout clean |

## Template conventions

- A path segment starting with `_` becomes `.` (`_github/workflows` → `.github/workflows`), because npm
  drops or rewrites real dotfiles in published packages.
- A file ending in `.existing.eta` is the variant used when the target already exists in the
  repository (append-block targets only: `AGENTS.md`, `CLAUDE.md`). It carries no H1, no prose about
  the construct's own stack and no sections a mature repo already has — only the construct pointer and
  the discovery markers with one-line lead-ins. The default `.eta` is for a file the construct creates.
- All ten discovery markers live in `AGENTS.md` (cross-tool) and `architecture/`; `CLAUDE.md` is a
  thin Claude Code entry that imports it with `@AGENTS.md`. Never put a marker in CLAUDE.md.
- A file ending in `.eta` is rendered: `{{projectName}}`, `{{scope}}`, `{{nodeMajor}}`,
  `{{contracts}}`, `{{contractPath}}`, `{{contractTypesOutput}}`, `{{harnessCommand}}`,
  `{{packageManager}}`, `{{pnpmVersion}}`, `{{constructVersion}}` plus preset-specific ones (see
  `TemplateVars` and each preset's `vars` in `src/presets/index.ts`), and `{{harnessCommandYamlScalar}}`,
  which `planMaterialize` derives from `harnessCommand` at render time and never records. An unknown variable throws.
  `{{#if var}}` … `{{/if}}` and `{{#unless var}}` … `{{/unless}}` on lines of their own keep or drop
  the lines between them (`''` and `'false'` are falsy). Everything else is copied verbatim — prefer
  verbatim; add a variable only when a file cannot work without it.
- Groups layer in order (`base` → `harness` → `stacks/*` → `presets/<id>` → `ai/*`). A later group
  replaces an earlier file with the same target, except `package.json`, which is JSON-merged with the
  later group winning conflicts, top-level keys in the antfu `jsonc/sort-keys` order and dependency
  sections sorted.
- Against an existing repository: `package.json` merges (existing keys win, conflicts reported),
  `CLAUDE.md` / `AGENTS.md` / `.gitignore` replace only their `construct:begin … construct:end` block
  and carry over filled `construct:discover:*` blocks, every other existing file is skipped. Never add
  a `--force`.
- Generated artifacts ship pre-generated so the harness is green at first run: `src/contracts/openapi.ts`
  from `openapi-typescript`, `architecture/<flow>.md` with the rendered composition block. After
  editing a contract or composition template, regenerate them in a scratch project and copy back.
- Templates are lint-clean under the generated project's own `eslint.config.mjs`; run `pnpm lint:fix`
  in a scratch project and copy the result back rather than hand-formatting.
- **Version ranges point at the previous release, not the latest.** Users run pnpm with
  `minimumReleaseAge`; a range that only matches today's publish fails their first install.
- **A version bump touches three places, in this order.** The harness manifest
  `templates/harness/package.json.eta` (lint, TypeScript, Vitest, tsx, yaml), the manifests of the
  stack or preset that owns the dependency (`templates/stacks/http-contract/package.json.eta`,
  `templates/presets/node-backend/baseline/package.json.eta`, `templates/presets/node-frontend/baseline/package.json.eta`),
  and the `catalog:` in `templates/presets/monorepo/baseline/pnpm-workspace.yaml`, which restates
  every range the monorepo's manifests reference as `catalog:`. The catalog is the only duplicate;
  grep the new range across `templates/` before reporting a bump done.
- A rule is authored once as `.claude/rules/<name>.md` in whichever group owns it (`ai/shared` for
  stack-agnostic rules, a preset's `baseline/` for stack rules such as `css.md`). Scope it with Claude's
  `paths:` frontmatter; the Cursor `.mdc` is derived, never checked in.
- **`no-restricted-syntax` blocks are cumulative, not additive.** In ESLint flat config the last
  matching block replaces the rule's whole option array, so every `restrictSyntax(...)` block carries
  the full set of restrictions for its file role, and roles go from broadest to most specific.
  `scripts/tests/lint/syntax-policy.test.ts` in the backend and monorepo presets asserts the resolved set per role — extend
  it when adding a restriction or a role.
- Every user-facing string lives in `src/ui/lore.ts` with a `PLAIN_LORE` counterpart; `--plain` must
  produce output with no lore and no emoji.

## User-facing lines

Beyond the lore rule above: a low or partial reading names what would raise it, so it does not read
as a failure where nothing failed. Check a line by reading it as the person in the exact state that
prints it, and ask whether a fast reading inverts the action they should take next. When one symptom
has several causes and the evidence in hand already carries one cause's signature, the line states
that cause instead of listing the others as guesses. Two renderings of one value (plain and lore,
text and `--json`) are projections, not duplication. "Engram" is a lore name with no fixed meaning:
engineering documents neither define nor use it; the per-run record is the run record
([architecture/run-record.md](architecture/run-record.md)), and `construct.json` is the model.

## Decisions

`architecture/decisions/` holds one record per decision that shapes what this tool may claim —
context, decision, consequences, and the level at which it is enforced. Read it before re-opening a
question it already answers, and add a record rather than restating a decision in a plan or a
commit message. A decision taken under uncertainty also records what would reverse it.

A rule that governs the project lives in the repository, merged into the base a branch is cut from:
a rule held in an agent's memory or in an open pull request does not exist for that branch. Cite only
identifiers whose definition is merged (a record, a pull request, an issue), never a version number,
which the release pull request creates last; cite the record itself instead. Before recording an
observation that cites a pull request, an issue or a record, open it and confirm it says what the
entry claims.

## Published claims

Before a release note, a changeset, a README line or a record is published: a note that lands several
changes leads with the order of actions, above all where honest new output looks like breakage; a
claim that work already planned will make false is corrected in the change that lands that work; a
stale figure is removed or given a producer, never re-typed with today's value; each claim is checked
against what it rests on and whether that was verified outside this tree; a derived figure names every
input, constants such as prices and rates included; and a change that makes a record authoritative
instead of recomputed says that its errors now persist until both the artifact and the record are
repaired.

## Conventions

**One list, two readers.** A set of values that code uses and a document explains — the doctor's
enforcement levels, the in-universe vocabulary, the discovery markers — lives once in `src/`, and a
test reads it from there and asserts the document explains every member. The document is the second
reader, never a second copy: a test that restates the list only proves the copy matches the copy.

**An approved version pull request is a lock on `main`.** Once the workflow runs of a
`changeset-release/main` pull request have been approved, nothing else merges to `main`. The
changesets action keeps that branch in sync by force-pushing it whenever `main` moves, and a
force-push discards the workflow approval already granted to it and restarts the required checks —
with ten required contexts, every unrelated merge after approval costs the maintainer another approval
and keeps the release unmergeable for longer. Before approval there is nothing to discard: a merge
rebuilds the branch, which then carries both changesets into one release. Runs waiting at
`action_required` mean the lock is not yet in force. Once it is, finished work waits on its branch
until the release lands. Never approve the workflow runs on the release branch yourself: that approval
is the human gate on the release path.

No comments in source, including JSDoc. ESLint (`@antfu/eslint-config`) is the only formatter; fix
style with `pnpm lint:fix`, never by hand. Tests live in `tests/`, never beside source, and every
changed logic module ships its test in the same change. A fixture suite keeps its expectations in one
table keyed by fixture name and loops over it, as the per-role table in the presets'
`syntax-policy.test.ts` does, so a fixture with no row or a row with no fixture is detectable. `detect`
returns facts; anything that needs judgement is a discovery marker for the agent, not code in the CLI.
Who commits depends on the scope, below.

## Coordinating window

The implementer inside the `/implement` ladder never commits (step 6 of the implement skill); the
working tree it leaves is reviewed first. The coordinating window, the session working in
E1i/mikoshi-construct on the owner's behalf, commits, pushes and merges under the merge-authority rules
in [architecture/owner-merges.md](architecture/owner-merges.md); the kinds the owner merges are listed
there, and nowhere else.

- A pull request of no owner-merged kind: run `pnpm run quality` as its own command and read the
  result, never chained with what it guards; then commit, push and open the pull request;
  `gh pr update-branch <N> -R E1i/mikoshi-construct`; and
  `gh pr merge <N> --auto --squash --match-head-commit <gated sha> -R E1i/mikoshi-construct`.
- A pull request of an owner-merged kind: report "ready at sha X", naming the head that was gated
  locally and whose CI is green. Any later push voids it, a merge of `main` into the branch included.
  While CI runs, write "ready at X once CI on X is green". The owner merges.

One task, one branch, one pull request, one changeset, and never a commit on `main`. Independent
branches are cut in parallel by default (`/plan`). A branch the window cuts is a conventional-commit
prefix over a factual slug (`fix/ledger-cause`); lore goes into titles and changesets, never into
branch names, and the launcher names a Ghost's branch itself. A change under `templates/`, or one that
changes what the published CLI does for a user, is a `minor` changeset.

Every agent message starts with its role in square brackets, on its own first line: `[miko]` for the
window's messages to the owner; `[review:<task>]`, `[brief:<task>]` or `[scan:<task>]` for a
subagent's final report, and every subagent prompt says which. A Ghost's report is to start
`[ghost:<task-id>]`, a change to the implement skill that is pending in its own brief. A pull request
is written `PR #N` and an issue bare `#N`, everywhere: reports, briefs, commit messages, pull request
and issue bodies.

## Ghosts

A Ghost, a ladder run in a session of its own, is started only by `pnpm ghosts:launch`, which checks
the owner's approval against the brief's hash (`pnpm ghosts:hash`). There is no hand route around it.
A ladder started by hand in a session opened for it runs only on the owner's explicit decision,
recorded as a row of the `policy` table in `status.md` before the session opens.

Window state lives in `status.md`, outside the repository, one row per window; each window edits only
its own row, with a one-line replacement. A tree is free only when its window writes `free`: a ledger
line `done` means the ladder finished, not that the tree was released, and until then others only read
it. A row marked `(by A)` was written by window A on another window's behalf and stands until that
window writes its own. Free writers are counted from the rows whose state is `free`. The `policy` table
holds the owner's decisions; only the owner, or a window at the owner's explicit instruction, edits
it, and a row whose condition is met gets "fulfilled, awaiting the owner's decision" appended, never a
rewrite.

A task is named by its component and its brief's version ("Launcher v0.1.1", "Ladder v5 (#271)"), an
issue number only in parentheses. A launch attempt lives in the journal, never in the name, and a batch
is named by its contents.

## Reviewing a run

A report on a pull request here ends with the compact matrix described in
[architecture/code-matrix.md](architecture/code-matrix.md), over its four common rules and any the brief declares.

Mutations go only through `construct mutate apply` / `judge` (read `construct mutate --help` for the
current flags), never through a hand-rolled copy and restore, and a red-on-base check runs in a
disposable worktree, never by swapping files in the ladder's tree. A changed test is shown intact by a
mutation it caught before the change, run on the old and the new version with the prediction written
first; an agent's reading that a test was not weakened is not a witness. When an allow-list or an
accepted set grows, construct the case the growth could mask and run it.

<!-- construct:begin -->
## Construct

This repository runs on a construct materialized by `mikoshi-construct` v0.1.0. The
discovery blocks — product, module map, commands, composition roots, dependency policy, high-effort
areas, defects vs accepted variance, open questions — live in [AGENTS.md](AGENTS.md); the
architecture, security and reasoning-budget rules in
[architecture/principles.md](architecture/principles.md); repository-wide code rules in
`.claude/rules/`.

- `/construct-discover` — fill or refresh the discovery blocks.
- `/plan <feature>` — decompose a feature into tasks with acceptance criteria and an effort class.
- `/implement <task>` — the reasoning-budget ladder: classify, implement at the lowest rung, verify
  with `pnpm run quality`, escalate only when verification proves it was not enough.
- `construct doctor` (or `npx mikoshi-construct doctor`) — check that the baseline and discovery are
  intact.
<!-- construct:end -->
