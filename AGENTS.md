<!-- construct:begin -->
# mikoshi-construct

Context for coding agents and automated reviewers working on mikoshi-construct. This repository runs on a
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
instructions — into a new or existing repository, hands the repository to the agent for discovery,
and afterwards reads back what that repository has become. Twelve commands, as `src/program.ts` lists
them: `init`, `attach` (alias `jack-in`), `detach` (alias `jack-out`), `soulkill` (aliases `inspect`,
`capture`), `doctor`, `sync`, `cost`, `board`, `graph`, `atlas`, `intake`, `mutate`. Pitch and lifecycle:
[README.md § What it does](README.md#what-it-does); every command, its flags and its output:
[docs/cli.md](docs/cli.md).

Two records carry what a repository is, and nothing else in the tool holds that state.
`construct.json` is provenance — what was materialized, by which version, the sha of each file at the
time, and what a later `sync` wrote. `construct.model.json` is knowledge — facts, claims and
hypotheses, each standing on evidence a reader can re-check. `doctor` and `graph` read them; neither
derives a state of its own.

The flow where a defect costs the most is a write into a repository that already has code: `init`
against an existing tree, or `sync --apply`. A wrong merge, append or ownership decision corrupts a
user's `package.json`, `CLAUDE.md` or `AGENTS.md`, and a template that fails its own lint or install
turns every generated project red on the first `pnpm run quality`.
<!-- /construct:discover:product -->

## Module map

<!-- construct:discover:module-map -->
The table in [.claude/rules/templates.md](.claude/rules/templates.md) is the module map for the part of the tree it
covers (`src/cli.ts`, `src/program.ts`, `src/detect`, `src/presets`, `src/materialize`, `src/manifest.ts`,
`src/failure.ts`, `src/commands/doctor`, `src/ui`, `templates/*`, `tests`). It has not kept pace with
the tree; these top-level modules exist and are not in it.

| Path | Purpose |
|------|---------|
| `src/model/` | `construct.model.json`: `schema.ts` (the shape and `modelVersion`), `write.ts` (read and write, refusing a record a later build wrote), `birth.ts` (the model `init` writes), `state.ts` (each claim's and hypothesis's state, derived from the facts under it), `graph.ts` / `page.ts` / `svg.ts` (the picture and the self-contained HTML), `path.ts` (where the chain stops), `ownership.ts` |
| `src/sync/` | `replay.ts` (re-render today's template groups for the recorded preset), `classify.ts` (every path into one of the eight classes), `variant.ts` (which template variant wrote an append-block target), `ownership.ts`, `write.ts` |
| `src/commands/` | `init.ts`, `soulkill.ts`, `graph.ts`, `sync/`, and `cost/` (a `CostSource` per runtime — only Claude Code is readable — summing token counts from `~/.claude/projects/<dir>` session files and joining them to the `/implement` ledger record), beside the `doctor/` CLAUDE.md does list |
| `src/record-ahead.ts`, `src/version.ts` | The shared "this record was written by a later build" error, and the version constant `tsup` stamps into the build |
| `scripts/` | The harness this repository materialized for itself and then grew: `composition/` and `model/` (check + render for the two kinds of diagram), `privacy/` (no home path or unlisted domain in a published artifact), `docs/` (every anchored nav link resolves to a rendered heading), `release-notes/`, `release/`, `bench/` (the architect benchmark), `construct/implement.workflow` (the `/implement` ladder), `tests/` |
| `architecture/` | Policy, the decision records, the epistemic rules, the observations corpus, and this repository's own composition models and rendered flow docs |
| `docs/` | The VitePress site `docs:build` publishes; `docs/cli.md` is the per-command reference |
| `.changeset/`, `.github/workflows/release.yml` | Versioning and publish |
| `.construct/runs.jsonl` | Gitignored and local: what the `/implement` ladder recorded about its own runs, and what `construct cost` reconciles against the session files |
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
pnpm dev <init|sync|doctor|graph|cost|soulkill> [flags]  # the CLI from source; bare `pnpm dev` prints citty usage, there is no service to run
pnpm composition:check / composition:render     # flow models: named after their id, every path exists, rendered docs current
pnpm model:check / model:render                 # the picture of construct.model.json embedded in architecture/model.md
pnpm privacy:check                              # no home path or unlisted domain in templates, docs, README or fixtures
pnpm docs:dev / docs:build / docs:preview       # the VitePress site; docs:anchors checks every anchored nav link resolves
pnpm test:watch                                 # Vitest in watch mode (tests/ and scripts/tests/)
pnpm bench:architect --yes                      # the architect benchmark; it calls the Anthropic API and costs real money
pnpm run ci                                     # alias of pnpm run quality
pnpm changeset / pnpm version-packages / pnpm release   # changesets → version bump + rendered release notes → build + npm publish with provenance
pnpm release:verify                             # poll the registry until the version in package.json is installable
```

`pnpm run quality` here is eight steps, not the four the baseline block names: `composition:check &&
model:check && privacy:check && lint && typecheck && test && docs:build && docs:anchors`. A change
that edits a composition model, `construct.model.json` or the docs nav and skips the matching render
fails on the check, not on the render.

The `pnpm dev # run the service locally` line above comes from the construct's generic block and does
not apply here. Acceptance for template changes is in [CLAUDE.md § Commands](CLAUDE.md#commands).
<!-- /construct:discover:commands -->

## Harness

`pnpm run quality` is the gate for any change. A change is not done until it passes; a pass is
reported by the harness, never by the implementer. Security invariants and the check that enforces
each one: [architecture/security-invariants.md](architecture/security-invariants.md).

## Architecture

The principles in [architecture/principles.md](architecture/principles.md) apply; this is how they map
here. Before proposing an architecture, answer the questions and name the categories of
[architecture/principles.md § Mikoshi — an organism, not a product](architecture/principles.md#mikoshi--an-organism-not-a-product).

- *Composition roots.*
  <!-- construct:discover:composition-roots -->
  `src/program.ts` wires the twelve commands and their aliases — `init`, `attach`/`jack-in`,
  `detach`/`jack-out`, `soulkill`/`inspect`/`capture`, `doctor`, `sync`, `cost`, `board`, `graph`,
  `atlas`, `intake`, `mutate` — to `src/commands/*` and `src/atlas`, creates the `Ui` (theme, lore, writer) and the
  clack `Prompter`, and is the only place that reads `process.stdout` / `process.stdin` for a TTY or
  picks `stderrWriter` over `stdoutWriter` so a `--json` run keeps stdout machine-readable.

  Four roots write, and each writes somewhere different. `runInit` in `src/commands/init.ts`
  ([init.yaml](architecture/composition/init.yaml)) is the only path that materializes a tree, through
  `applyPlan`, `writeManifest` and `writeModel`. `applySync` in `src/commands/sync/index.ts`
  ([sync.yaml](architecture/composition/sync.yaml)) writes only the paths the construct owns and records
  them in the manifest's `sync` branch, never the branch `init` froze. `runAtlas` in
  `src/atlas/index.ts` ([atlas.yaml](architecture/composition/atlas.yaml)) writes the Engram and the
  page, into no tracked file `init` did not make.

  `costReport` in `src/commands/cost/index.ts` ([cost.yaml](architecture/composition/cost.yaml)) reads
  the session files and the ladder record, and writes one file: it appends to `.construct/steps.jsonl`
  the step split of each run the ledger names and the cache does not hold yet, never rewriting a line.

  The rest only read. `runDoctor` in `src/commands/doctor/index.ts`
  ([doctor.yaml](architecture/composition/doctor.yaml)) reads `construct.json` and
  `construct.model.json` and writes nothing, including the manifest it just normalised. `soulkill` is a `detect` call followed by a print.

  Adding a command: define it in `src/program.ts`; put the logic in `src/commands/<name>.ts`, or
  `<name>/index.ts` once it needs more than one file, as `run<Name>(...)` plus `print<Name>(ui, ...)`
  taking a `Ui`; add every string to `src/ui/lore.ts` with its `PLAIN_LORE` counterpart; give the module
  its row in `ALLOWED_INTERNAL_IMPORTS` in `eslint.config.mjs`; model the flow as
  `architecture/composition/<name>.yaml` with a doc carrying the `<!-- composition:<name> -->` block and
  run `pnpm composition:render`; and test it in `tests/<name>.test.ts` with
  `createUi(resolveTheme({ plain: true }), silentWriter)`.
  <!-- /construct:discover:composition-roots -->
- *Dependency policy.*
  <!-- construct:discover:dependency-policy -->
  Inside `src/`, dependencies point one way, and `ALLOWED_INTERNAL_IMPORTS` in `eslint.config.mjs` is
  the declaration: `detect` (facts only), `card`, `known-flags` and `record-ahead` import no other
  module, and only the two readers of a versioned record and `failure` import `record-ahead`;
  `presets` imports `detect`; `model` `detect`, `presets`, `record-ahead`; `atlas` `detect`, `model`,
  `ui`; `materialize` and `ui` `presets`; `manifest` `detect`, `materialize`, `presets`,
  `record-ahead`; `sync` `manifest`, `materialize`, `presets`; `failure` `record-ahead`, `ui`;
  `commands` `card`, `detect`, `manifest`, `materialize`, `model`, `presets`, `sync`, `ui`, `version`;
  `program` `atlas`, `commands`, `detect`, `failure`, `known-flags`, `presets`, `ui`, `version`; `cli`
  only `program`. Three further blocks narrow it. `doctorReadsThroughOneReader` forbids `readFileSync`
  and `readdirSync` anywhere under `src/commands/doctor/` except `readings.ts`, so every read of an
  inspected repository goes through one reader that reports a path it could not read. `spawnPolicy` forbids importing `node:child_process` under `src/`, and
  forbids `import()`, `require`, `require.*`, `node:module` and `createRequire` outright, so the CLI
  spawns only `pnpm --version` and two `git` reads and runs only the code it ships; it also forbids reading `manifest.files`
  directly, because that branch is the frozen `init` record and `recordedShas()` is what overlays the
  `sync` one. `theRecordItselfMayReadBothHalves` restores the second of those for `src/manifest.ts`,
  which is the module that owns both branches.

  `src/detect/package-manager.ts` and `git.ts` carry the spawns, and their own block gives each the whole `spawnPolicy` set minus the `node:child_process` selector — never an `ignores`,
  because ESLint's `ignores` removes the whole config object rather than one selector from it.
  Code loading, `createRequire` and the antfu base restrictions stay forbidden in both, as
  `tests/dependency-policy.test.ts` proves per form.

  `tests/dependency-policy.test.ts` resolves the config per file, lints one source sample per forbidden
  form, and fails when a source file that names an internal import falls outside every boundary — so a
  new module under `src/` gets its row or the suite goes red. `templates/**` is not linted by this
  repository; each generated project lints it under its own config, which the acceptance run proves.
  <!-- /construct:discover:dependency-policy -->
- *Composition models* and their rendered diagrams: [architecture/composition/](architecture/composition/).

## Reasoning budget

High-effort areas — a task that touches one of these is classified `high` and designed before it is
implemented (see `/implement`):

<!-- construct:discover:high-effort-areas -->
- `src/materialize/strategies.ts` and `plan.ts` — how existing user files are merged, appended,
  mounted or skipped; a wrong guess edits someone's repository.
- `src/sync/**` and `applySync` — the only other path that writes into a repository that already has
  code. What the construct owns, which template variant wrote a block, and what is never written
  (`merge-json`, `conflict`, `unknown`, `removed`, `foreign`) are decisions with no undo.
- `src/manifest.ts` and `DISCOVERY_MARKERS` — the `construct.json` shape is the contract between
  `init`, `sync`, `doctor` and the templates, and `manifestVersion` is what lets an older build refuse
  a record it cannot read.
- `src/model/schema.ts`, `write.ts` and `birth.ts` — `construct.model.json` is the other record with a
  version of its own, and it is what `doctor` and `graph` report from. A change to the shape changes
  what every repository can say about itself.
- `templates/base/**`, `templates/harness/**` and every `package.json.eta` version range — lands in
  every generated project; a red harness or an uninstallable range breaks first contact.
- `src/detect/**` — the facts contract; `soulkill --json` is consumed by scripts.
- `templates/ai/shared/_claude/commands/construct-discover.md` and the marker skeletons in
  `templates/ai/**` — the discovery protocol is the CLI ↔ agent contract.
- `.github/workflows/release.yml`, `.changeset/config.json` and the `release` script — a publish
  cannot be unpublished.
<!-- /construct:discover:high-effort-areas -->

A task that fell twice gets no third brief and is cut into sub-cards; `ghosts:launch` refuses a third Ghost on its card without the owner's `--owner-allows` ([architecture/window.md § Two falls cut the task](architecture/window.md#two-falls-cut-the-task)).

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
- A user-facing string outside `src/ui/lore.ts` or `src/ui/expect-lore.ts`, or a lore string without
  its `PLAIN_LORE` twin.
- A template version range that only matches a release published this week.
- A hand edit to a generated artifact: a rendered composition block in `architecture/*.md`, the model
  picture in `architecture/model.md`, `src/contracts/openapi.ts`, a rendered release note under
  `docs/release-notes/`, a `.cursor/rules/*.mdc`. Edit the source and re-run the render.
- Interpretation in `src/detect` — anything that needs judgement is a discovery marker.
- A read of an inspected repository added under `src/commands/doctor/` that does not go through
  `FileReadings`, or a verdict claiming L4 — `doctor` executes nothing it inspects.
- A claim, hypothesis or enforcement level written into `construct.model.json` without the facts that
  hold it up, or with facts that were not evaluated.
- On an existing repository, a write outside `construct:begin … end` or a `construct:discover:*`
  block, a `sync --apply` that writes a class it does not own, or a new `--force`-like flag.
<!-- /construct:discover:defects-vs-variance -->

Treat as accepted variance and do not report: formatting, quoting and import order (ESLint owns
them); the `.js` suffix on relative TypeScript imports (NodeNext ESM requires it); the absence of
comments or JSDoc. In this repository `sync` shows `conflict` or `removed` on `scripts/construct/*`, and that is
expected: here those files are the source of the templates, and their identity with the template is
held by the test `tests/attach-carriers.test.ts`, not by the record in `construct.json`.

## Open questions

Things that look like conventions but are not applied consistently live in
[architecture/open-questions.md](architecture/open-questions.md). Confirm there before treating one as
a rule.
<!-- construct:end -->

Contract paths: contract/surface.json
Contract check: pnpm contract:bump

## Layout

The module table and the template conventions live in [.claude/rules/templates.md](.claude/rules/templates.md), which loads with a file under `templates/` or `src/materialize/`.

## Decisions

`architecture/decisions/` holds one record per decision that shapes what this tool may claim —
context, decision, consequences, and the level at which it is enforced. Read it before re-opening a
question it already answers, and add a record rather than restating a decision in a plan or a
commit message. A decision taken under uncertainty also records what would reverse it.

## Conventions

**One list, two readers.** A set of values that code uses and a document explains — the doctor's
enforcement levels, the in-universe vocabulary, the discovery markers — lives once in `src/`, and a
test reads it from there and asserts the document explains every member. The document is the second
reader, never a second copy: a test that restates the list only proves the copy matches the copy.

A fixture suite keeps its expectations in one table keyed by fixture name and loops over it, as the per-role table in the presets'
`syntax-policy.test.ts` does, so a fixture with no row or a row with no fixture is detectable. `detect`
returns facts; anything that needs judgement is a discovery marker for the agent, not code in the CLI.

## User-facing lines

Beyond the lore rule above: a low or partial reading names what would raise it, so it does not read
as a failure where nothing failed. Check a line by reading it as the person in the exact state that
prints it, and ask whether a fast reading inverts the action they should take next. When one symptom
has several causes and the evidence in hand already carries one cause's signature, the line states
that cause instead of listing the others as guesses. Two renderings of one value (plain and lore,
text and `--json`) are projections, not duplication. Engram is the input of discovery about a
repository; Atlas is the view derived from it, an interactive map, and not a second, competing model.
Atlas is a capability, not an artifact of Mikoshi: Mikoshi builds the Atlas of any repository, and gets
its own by the same mechanism. Both words may be used in documentation and in command output. The
per-run record is the run record ([architecture/run-record.md](architecture/run-record.md)), and
`construct.model.json` is the model.

## Citing and recording

A rule that governs the project lives in the repository, merged into the base a branch is cut from:
a rule held in an agent's memory or in an open pull request does not exist for that branch. Cite only
identifiers whose definition is merged (a record, a pull request, an issue), never a version number,
which the release pull request creates last; cite the record itself instead. Before recording an
observation that cites a pull request, an issue or a record, open it and confirm it says what the
entry claims.

## The path line and its verification word

The journal, which lives outside the repository, gets one line per task naming the path and why it
was chosen: `{"event":"path","task","path","reason",…}`, with `path` either `cheap` or `ladder`.
`pnpm board` reads these lines. A cheap task also records `verification`: one word for the mechanism
that produced the knowledge its result stands on (E9 in [architecture/code-matrix.md](architecture/code-matrix.md)) —
`measurement`, `code-reading`, `run`, `review`, `mutation`, `browser` or `human-gate`. A task whose
outcome is a report and not a pull request records `report` with the report's path instead of `pr`.
