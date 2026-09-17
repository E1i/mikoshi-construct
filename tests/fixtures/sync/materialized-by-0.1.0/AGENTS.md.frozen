<!-- construct:begin -->
# mikoshi-construct

Context for coding agents and automated reviewers working on d4. This repository runs on a
construct materialized by `mikoshi-construct` v0.1.0: architecture policy in
[architecture/](architecture/), a harness that proves every change, and the rules that apply to all
code in [architecture/principles.md](architecture/principles.md). What follows is what is specific to
this repository. Sections marked "not discovered yet" are filled by construct discovery
(`/construct-discover` in Claude Code, "run construct discovery" in Cursor), then kept current by
whoever changes the thing they describe.

## What this product does

<!-- construct:discover:product -->
`mikoshi-construct` is a CLI (`construct`, `miko`, `npx mikoshi-construct`) that materializes a
construct — architecture policy, an optional OpenAPI contract, a quality harness and agent
instructions — into a new or existing repository, then hands the repository to the agent for
discovery. Four commands: `init` (detect, configure, materialize), `doctor` (is the baseline and the
discovery intact), `soulkill` (print the detected facts, write nothing), `cost` (token usage of
`/implement` runs). Pitch and lifecycle: [README.md § What it does](README.md#what-it-does).

The flow where a defect costs the most is `init` against a repository that already has code: a
wrong merge or append strategy corrupts a user's `package.json`, `CLAUDE.md` or `AGENTS.md`, and a
template that fails its own lint or install turns every generated project red on the first
`pnpm run quality`.
<!-- /construct:discover:product -->

## Module map

<!-- construct:discover:module-map -->
The table in [CLAUDE.md § Layout](CLAUDE.md#layout) is the module map (`src/cli.ts`, `src/detect`,
`src/presets`, `src/materialize`, `src/manifest.ts`, `src/commands`, `src/ui`, `templates/*`,
`tests`). Not listed there: `src/commands/cost/` (a `CostSource` per runtime — only Claude Code is readable —
reading `~/.claude/projects/<dir>` session files and summing token usage per workflow run), `scripts/composition` and `scripts/tests` (the harness this repo
materialized for itself), `scripts/construct/implement.workflow.mjs` (the `/implement` ladder),
`architecture/` (policy and the composition models of this repo), `docs/PLAN.md` (plan, closed
decisions, day log), `.changeset/` and `.github/workflows/release.yml` (versioning and publish).
<!-- /construct:discover:module-map -->

## Commands

```bash
pnpm dev             # run the service locally
pnpm run quality     # the harness: contract + composition checks, lint, typecheck, tests — the CI gate and the agent gate
pnpm composition:render # regenerate architecture diagrams after editing a composition model
pnpm lint:fix        # ESLint with --fix; ESLint is the only formatter
```

Use `pnpm run quality` / `pnpm run ci` — bare `pnpm ci` is a pnpm install builtin, not this script.

<!-- construct:discover:commands -->
```bash
pnpm dev <init|doctor|soulkill|cost> [flags]   # the CLI from source; bare `pnpm dev` prints citty usage, there is no service to run
pnpm dev cost --dir . [--last] [--json]         # token usage of /implement runs recorded for this directory
pnpm composition:check                          # models named after their id, paths exist, rendered docs current
pnpm test:watch                                 # Vitest in watch mode (tests/ and scripts/tests/)
pnpm run ci                                     # alias of pnpm run quality
pnpm changeset / pnpm version-packages / pnpm release   # changesets → version bump → build + npm publish with provenance
```

The `pnpm dev # run the service locally` line above comes from the construct's generic block and
does not apply here. Acceptance for template changes is in [CLAUDE.md § Commands](CLAUDE.md#commands).
<!-- /construct:discover:commands -->

## Harness

`pnpm run quality` is the gate for any change. A change is not done until it passes; a pass is
reported by the harness, never by the implementer. Security invariants and the check that enforces
each one: [architecture/security-invariants.md](architecture/security-invariants.md).

## Architecture

The principles in [architecture/principles.md](architecture/principles.md) apply; this is how they map
here.

- *Composition roots.*
  <!-- construct:discover:composition-roots -->
  `src/cli.ts` wires the four citty commands to `src/commands/*` and creates the `Ui` (theme, lore,
  writer) and the clack `Prompter`; it is the only place that reads `process.stdout` / `stdin` for a
  TTY. `runInit` in `src/commands/init.ts` is the root of the init flow — modelled in
  [architecture/composition/init.yaml](architecture/composition/init.yaml) — and the only code path that
  writes to a target directory (through `applyPlan` and `writeManifest`). `runDoctor` in
  `src/commands/doctor/` is the root of the doctor flow ([doctor.yaml](architecture/composition/doctor.yaml)).
  `soulkill` and `cost` are a detect or collect call followed by a print. Adding a command: define it in
  `src/cli.ts`, put the logic in `src/commands/<name>.ts` as `run<Name>(...)` plus `print<Name>(ui, ...)`
  taking a `Ui`, add every string to `src/ui/lore.ts` with its `PLAIN_LORE` counterpart, and test it in
  `tests/<name>.test.ts` with `createUi(resolveTheme({ plain: true }), silentWriter)`.
  <!-- /construct:discover:composition-roots -->
- *Dependency policy.*
  <!-- construct:discover:dependency-policy -->
  Inside `src/`, dependencies point one way: `detect` imports no other module (facts only);
  `presets` imports `detect`; `materialize` and `ui` import `presets`; `manifest` imports `materialize`
  and `presets`; `commands` import everything except `cli`; `cli` composes it all. `node:child_process`
  is imported only by `src/detect/package-manager.ts` (the single spawn, `pnpm --version`).
  `eslint.config.mjs` enforces both (`ALLOWED_INTERNAL_IMPORTS`, the `no-restricted-syntax` block) and
  `tests/dependency-policy.test.ts` asserts the resolved rules. `templates/**` is not linted by this
  repo — each generated project lints it under its own config, which the acceptance run proves.
  <!-- /construct:discover:dependency-policy -->
- *Composition models* and their rendered diagrams: [architecture/composition/](architecture/composition/).

## Reasoning budget

High-effort areas — a task that touches one of these is classified `high` and designed before it is
implemented (see `/implement`):

<!-- construct:discover:high-effort-areas -->
- `src/materialize/strategies.ts` and `plan.ts` — how existing user files are merged, appended,
  mounted or skipped; a wrong guess edits someone's repository.
- `src/manifest.ts` and `DISCOVERY_MARKERS` — the `construct.json` shape is the contract between
  `init`, `doctor`, the templates and a future `sync`.
- `templates/base/**`, `templates/harness/**` and every `package.json.eta` version range — lands in
  every generated project; a red harness or an uninstallable range breaks first contact.
- `src/detect/**` — the facts contract; `soulkill --json` is consumed by scripts.
- `templates/ai/shared/_claude/commands/construct-discover.md` and the marker skeletons in
  `templates/ai/**` — the discovery protocol is the CLI ↔ agent contract (docs/PLAN.md § 1).
- `.github/workflows/release.yml`, `.changeset/config.json` and the `release` script — a publish
  cannot be unpublished.
<!-- /construct:discover:high-effort-areas -->

Always high, whatever discovery finds: `architecture/composition/`, `eslint.config.mjs`, and every
row of [architecture/security-invariants.md](architecture/security-invariants.md).

## Conventions the harness does not enforce

No comments in source (functional pragmas such as `eslint-disable*` and `@ts-expect-error` are
compiler input and are never removed). `async`/`await` over promise chains where the enclosing context
can be async. Tests live in `tests/**` as `*.test.ts`, never beside the source, and every new or
changed logic module ships its test in the same change. ESLint is the only formatter.

## Real defects vs accepted variance

Treat as real defects:

- A new or changed logic module with no test file.
- A response shape that drifts from the API contract, or a breaking change to a `/v1` endpoint that
  was not identified deliberately.
- A secret, API key or connection string written into any file. Config references the environment.
- Any row of [architecture/security-invariants.md](architecture/security-invariants.md) that a change
  weakens.

<!-- construct:discover:defects-vs-variance -->
- A change under `templates/` or `src/materialize` reported done without the acceptance run
  (empty directory → `init` → `pnpm install` → `pnpm run quality`).
- A user-facing string outside `src/ui/lore.ts`, or a lore string without its `PLAIN_LORE` twin.
- A template version range that only matches a release published this week.
- A hand edit to a generated artifact: a rendered composition block, `src/contracts/openapi.ts`, a
  `.cursor/rules/*.mdc`.
- Interpretation in `src/detect` — anything that needs judgement is a discovery marker.
- On an existing repository, a write outside `construct:begin … end` or a `construct:discover:*`
  block, or a new `--force`-like flag.
<!-- /construct:discover:defects-vs-variance -->

Treat as accepted variance and do not report: formatting, quoting and import order (ESLint owns
them); the `.js` suffix on relative TypeScript imports (NodeNext ESM requires it); the absence of
comments or JSDoc.

## Open questions

These look like conventions but the codebase is not consistent about them. Confirm before treating
them as rules.

<!-- construct:discover:open-questions -->
- `scripts/tests/lint/syntax-policy.test.ts` ships only in the node-backend and monorepo samples;
  node-frontend's styling policy has no test that asserts the resolved lint restrictions per role.
- Commands are listed in three places: README, CLAUDE.md § Commands and AGENTS.md. Which one the
  other two should point at is not settled.
<!-- /construct:discover:open-questions -->
<!-- construct:end -->
