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
and afterwards reads back what that repository has become. Six commands: `init` (detect, configure,
materialize), `sync` (classify what today's construct would change; `--apply` writes only what it
owns), `doctor` (are the baseline, the discovery and the knowledge intact), `graph` (draw the claims
and the evidence under them), `cost` (token usage of `/implement` runs), `soulkill` (print the
detected facts, write nothing; aliases `inspect`, `capture`). Pitch and lifecycle:
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
The table in [CLAUDE.md § Layout](CLAUDE.md#layout) is the module map for the part of the tree it
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
here.

- *Composition roots.*
  <!-- construct:discover:composition-roots -->
  `src/program.ts` wires the six citty commands — `init`, `sync`, `doctor`, `graph`, `cost`, `soulkill`
  (aliases `inspect`, `capture`) — to `src/commands/*`, creates the `Ui` (theme, lore, writer) and the
  clack `Prompter`, and is the only place that reads `process.stdout` / `process.stdin` for a TTY or
  picks `stderrWriter` over `stdoutWriter` so a `--json` run keeps stdout machine-readable.

  Three roots write, and each writes somewhere different. `runInit` in `src/commands/init.ts`
  ([init.yaml](architecture/composition/init.yaml)) is the only path that materializes a tree, through
  `applyPlan`, `writeManifest` and `writeModel`. `applySync` in `src/commands/sync/index.ts`
  ([sync.yaml](architecture/composition/sync.yaml)) writes only the paths the construct owns and records
  them in the manifest's `sync` branch, never the branch `init` froze. `writeGraphPage` in
  `src/commands/graph.ts` ([graph.yaml](architecture/composition/graph.yaml)) writes one HTML file at
  the path `--out` names, outside the repository it read.

  The rest only read. `runDoctor` in `src/commands/doctor/index.ts`
  ([doctor.yaml](architecture/composition/doctor.yaml)) reads `construct.json` and
  `construct.model.json` and writes nothing, including the manifest it just normalised. `costReport` in
  `src/commands/cost/index.ts` ([cost.yaml](architecture/composition/cost.yaml)) reads the session files
  and the ladder record. `soulkill` is a `detect` call followed by a print.

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
  the declaration rather than a description of one: `detect` imports no other module (facts only);
  `presets` imports `detect`; `record-ahead` imports nothing, and only the two readers of a versioned
  record and the failure reader may import it; `model` imports `detect`, `presets` and `record-ahead`;
  `materialize` and `ui` import `presets`; `manifest` imports `detect`, `materialize`, `presets` and
  `record-ahead`; `sync` imports `manifest`, `materialize` and `presets`; `failure` imports
  `record-ahead` and `ui`; `commands` import everything but `cli`, `program` and `record-ahead`; `program` composes `commands`, `detect`, `presets`, `ui` and `version`; `cli` imports only
  `program`. Three further blocks narrow it. `doctorReadsThroughOneReader` forbids `readFileSync`
  and `readdirSync` anywhere under `src/commands/doctor/` except `readings.ts`, so every read of an
  inspected repository goes through one reader that reports a path it could not read instead of dropping
  it from the set it inspected. `spawnPolicy` forbids importing `node:child_process` under `src/`, and
  forbids `import()`, `require`, `require.*`, `node:module` and `createRequire` outright, so the CLI
  spawns only `pnpm --version` and runs only the code it ships; it also forbids reading `manifest.files`
  directly, because that branch is the frozen `init` record and `recordedShas()` is what overlays the
  `sync` one. `theRecordItselfMayReadBothHalves` restores the second of those for `src/manifest.ts`,
  which is the module that owns both branches.

  `src/detect/package-manager.ts` carries the single spawn, and `thePnpmProbeMaySpawnAndNothingElse`
  gives it the whole `spawnPolicy` set minus the `node:child_process` selector — never an `ignores`,
  because ESLint's `ignores` removes the whole config object rather than one selector from it.
  Code loading, `createRequire` and the antfu base restrictions stay forbidden there, and
  `tests/dependency-policy.test.ts` lints one sample per form against that file.

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
comments or JSDoc.

## Open questions

These look like conventions but the codebase is not consistent about them. Confirm before treating
them as rules.

<!-- construct:discover:open-questions -->
- **Which of the three documents that list commands is the source?** That all three state the
  command list is structural and is recorded as the hypothesis
  `the-command-list-is-stated-in-three-documents` in `construct.model.json`, which stands on a fact
  per document and is re-derived on every read. Which one the other two should point at is judgment,
  stays here, and ages: nothing re-checks this paragraph.
- **Where does evidence of enforcement capability belong?** The model records the declared
  enforcement mechanism and evidence that the mechanism exists and runs. It does not represent
  evidence that the mechanism can actually *fail* when the invariant it protects is violated.
  Harness mutation tests are evidence of enforcement capability, and PR #57 added an observed case
  of a different kind: `testsWeakened` caught erosion in a live implementation change rather than in
  a dedicated mutation fixture. A second class was observed on 2026-09-21 — tests deleted alongside
  the modules they covered, where legitimacy needed human adjudication. That occurrences of both live in
  [architecture/observations.md](architecture/observations.md) rather than in the records they bear
  on is carried by the hypothesis `occurrences-live-in-observations-not-in-the-records-they-bear-on`;
  neither is offered as a frequency. So is enforcement capability a fact about the repository, which the
  model should represent, or process evidence belonging to the corpus and the harness history?
  Do not resolve this before `doctor` consumes the model. Revisit it when `doctor` reads the model
  on a live repository and a useful diagnosis turns out to need a fact the model cannot provide.
  Until then the blind spot is represented by the absence of a question the model can answer — not
  by synthesising an `unknown` value or any equivalent derived status, which would assert that the
  question was asked and came back empty.
  **Candidate evidence, observed 2026-09-21, leaning toward "a repository fact".** On that date the
  claim `vulnerable-dependencies-are-visible` rendered `held` at **L3** while the job behind it
  carried `continue-on-error` and could not fail. That the job still cannot fail is structural and is
  carried by the hypothesis `the-dependency-audit-job-cannot-fail`; what level the claim declares
  today is in `construct.model.json` and is not restated here. What the observation showed stands: that a mechanism cannot fail is a property of a
  workflow file — a fact about the repository, checkable from the repository — which is what tilts
  this one case toward the first answer. It is one case and the question stays open. Note also where it
  surfaced: on the construct's own repository, before any other, and the second half of 0017's
  acceptance is still owed by a repository the construct never materialized. The inspection that
  found it is recorded in
  [architecture/observations.md](architecture/observations.md).
  If it resolves towards "a repository fact", it becomes a **new rule number**, never an expansion
  of [rule 8](architecture/epistemic-rules.md). The two are adjacent in meaning and must stay
  separate in identity: *a command exists → the enforcement level* is rule 8, and *the enforcement
  level → the capability demonstrated* would be the new rule. Rule 8 may later point at it with a
  "see also"; its own scope stays as written.
- **Has an interpretation been reconsidered since the tree around its facts changed?** The model has
  no way to say, and this is an absence of means rather than a suspicion about any entry. All seven
  hypotheses here hold every fact under them and each records `baseSha` `906f554`, while `HEAD` is
  four commits further on. **Facts holding is not the same as an interpretation still being apt**: a
  file can go on containing what a fact names while the reason that mattered has moved underneath it.
  The model neither asserts nor denies that today, and nothing in it is claimed to have gone stale —
  saying "may have gone stale" would be a weak claim that it has. What is `unknown` is whether a
  reconsideration is owed, which is [rule 2](architecture/epistemic-rules.md) applied to the model's
  own interpretations rather than to a repository's enforcement.

  This sits beside the enforcement-capability question above and answers something different. That
  one asks whether a declared mechanism can actually enforce the claim it names; this one asks
  whether an interpretation has been looked at again since the ground under it moved. They share a
  genre and must not be merged.

  The obstacle is what makes it a question rather than a task. Answering it means reading what
  changed under a hypothesis's facts since its `baseSha`, which means `git` — and `doctor` executes
  nothing from the repository it inspects
  ([0007](architecture/decisions/0007-doctor-executes-nothing.md)). Whether that boundary covers
  `git`, which is not the inspected repository's code but is still execution, is part of what this
  question asks. It is not resolved here and no mechanism is proposed.
- **How does a repository materialized before 0.5.0 get a model?** **Settled by practice, not by
  decision: option three shipped.** That the upgrade guide names `init` as the step that writes a
  model is carried by the hypothesis `the-upgrade-guide-names-init-as-what-writes-a-model` — the
  third option below, taken and published without this question being told. It shipped in #121 on 2026-09-21, the
  same day this marker was last revised in #92, and nothing re-read the question in between, because
  nothing re-reads it at all. What is still open is narrower and is judgment: whether an explicit
  command should exist so that acquiring a model is not a side effect of a command named for
  something else.

  `construct.model.json` is written only by `init` and is not materialized from templates, so `sync`
  never creates one. The three options as originally written: `sync` learns to write a fresh model when none exists, which puts repository knowledge
  in a command whose job is file provenance and blurs the line
  [0016](architecture/decisions/0016-the-model-is-the-source.md) draws; an explicit command, which
  keeps the two apart but adds surface for a file the tool can already write; or nothing until the
  repository's next `init`, which is the smallest change and leaves `doctor` reporting `unknown` about
  claims for as long as that takes. The third is only tolerable because a missing model is honestly
  `unknown` rather than a failure — so the projection's no-model acceptance must land before this is
  decided, not after.
  **What this now blocks, 2026-09-21.** Since discovery writes its hypotheses into
  `construct.model.json` and creates none where the file is absent, a repository that arrived at the
  current baseline through `sync` from 0.4.x has nowhere for discovery to write: it can fill every
  marker and still record nothing structural, and `doctor` can say nothing about what that repository
  takes itself to be. Self-identification is therefore unavailable to those repositories until their
  first `init`. That is what makes this question gating rather than academic for any repository in
  that state; how many are in that state is not known here and is not asserted. It is not decided here; the three options above stand as written.
- **What can record provenance for a marker whose body was written before anything recorded it?**
  `doctor` reports nine markers here as carrying no recorded provenance, and they are not to be
  backfilled. Recording a sha asserts that the body it hashes is the construct's own words, written by
  the run that recorded it. With no sha on file there is no evidence of what those bodies now are —
  the construct's text from an earlier run, or an owner's edit since — so hashing them today would
  turn *never looked* into *checked and matching*. That is [rule 2](architecture/epistemic-rules.md)
  in the direction that manufactures support, and it is the laundering
  `.claude/commands/construct-discover.md` forbids when it records provenance only for the markers a
  run filled and leaves the rest with the entry they had, applied to nine markers at once.

  So `unrecorded` is the true state here and it stays. Provenance can be recorded only by the run that
  wrote the body: the next discovery run records it for the markers it rewrites, and the rest go on
  reading `unrecorded`, truthfully.

  **What is open is the shape any answer can take, not whether to backfill.** The step that knows what
  body it wrote is a hand-written L0 step — the run sets `discovery.markers.<name>` itself, and nothing
  checks that it did so, or that the sha it wrote is of the text it actually wrote. Any command that
  records provenance after the fact is indistinguishable, at the moment it runs, from the laundering
  above: it reads a body it did not write and asserts authorship of it. So an answer cannot be a
  command the owner runs afterwards. Either the write happens inside the same act that authors the
  body, or it does not happen. That is the constraint; no design is proposed here, and nothing about
  the nine is repaired by naming it.
- **What makes a machine-readable output refuse a reader it can no longer serve, and is that the
  mechanism the two records already share?** `construct.json` declares `manifestVersion` and
  `construct.model.json` declares `modelVersion`, and each refuses a record written by a later build
  through one shared error rather than one of its own. `doctor --json` declares nothing: `src/program.ts`
  serialises `DoctorResult` as it stands, so the output carries no statement of what it is, and there
  is nothing for a reader to check or for the tool to refuse. A consumer matching a value that has
  since changed — `authorship: "unknown"`, which 0.16.1 no longer emits — receives no error; its
  branch simply stops firing.

  The two are not the same situation and the question is partly whether they can share an answer. A
  record is read by this tool, which can refuse it; an output is read by somebody else's code, which
  this tool cannot make check anything. What a version buys there is the ability to be refused *by*
  the reader, which is a different transaction from the one `RecordAheadOfReader` performs.

  **Measured before this was written: the consumer count is zero.** Nothing the construct materializes
  calls `doctor --json` — not the templates, not the workflows, not `construct-discover.md`. Every
  match outside the source is built documentation or release-note prose. **That is what makes an
  answer cheap now rather than what makes it unnecessary**: the reason to declare what an output is
  does not arrive with the first consumer, but the cost of declaring it does. Nothing is designed or
  decided here.
- **Can an owner declare a construct-owned path they do not want, and files they maintain themselves,
  so that `doctor` can tell a declared deviation from an unknown one?** `doctor` exits 1 here for two
  conditions that are legitimate and permanent. `tsconfig.base.json` is recorded in the manifest's
  `sync` branch and absent from the tree. Fifteen baseline files are modified since `init`, which is
  what a repository that edits its own construct files looks like. Neither will become green, and a
  third condition — a real one — would arrive in the same exit code and go unread. **A check that can
  never be green reports as much as one that can never fail**, and this one now carries two permanent
  reasons for a reader to stop looking. Nothing is designed here and nothing is repaired: the `sync`
  record is a record of the past.

  **What is measured about the missing path, and what is only stated.** Measured: the recorded hash
  `040735e3…` is byte-identical to `templates/harness/tsconfig.base.json`, and `git log --all --follow`
  over the path returns nothing, so git holds no evidence either way about whether the file was ever on
  disk here. Stated, not measured: the message of commit `9c00c33` says `--apply` wrote the path and
  that it was then deleted, as it had been before. The owner does not recall deleting it. Those are two
  different kinds of claim and the second is not a record of the action, only a description of one.

- **What evidence does a run leave of a path it wrote, when git never tracked that path?** The one
  above is recoverable only from prose. `sync --apply` writes a file and records its hash in
  `construct.json`; the file itself, if it is one the repository does not track, leaves no trace of
  having existed — not in the history, not in the tree once it is gone. So what a run did is
  reconstructable from the record of *what it intended to write* and from whatever a commit message
  happens to say, and those are the two things above that must be kept apart. This is named, not
  answered.
<!-- /construct:discover:open-questions -->
<!-- construct:end -->

Contract paths: contract/surface.json
Contract check: pnpm contract:bump

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
| `templates/ai/shared`, `ai/claude`, `ai/cursor` | `AGENTS.md` and the rules (`shared/_claude/rules/*.md`, one source for both agents); `CLAUDE.md`, `.claude/` agents + skills + commands, `scripts/construct/implement.workflow` (the ladder script, with no `.mjs` so that a repository's `eslint .` does not parse its top-level `return`; it lives outside `.claude/` because Claude Code's permission classifier treats a Workflow script read from `.claude/` as self-modification, and the Workflow sandbox allows no `import()`, no filesystem and no bare `new Date()`) (claude); `.cursor/rules/construct.mdc` (cursor). `src/materialize/rules.ts` renders every `.claude/rules/*.md` in the plan to `.cursor/rules/*.mdc` for a Cursor target (`paths:` → `globs`, none → `alwaysApply: true`) and drops the `.claude` copy when the target is Cursor only. The discovery protocol `shared/_claude/commands/construct-discover.md` maps the same way to `.cursor/rules/construct-discover.mdc` (agent-requested, `$ARGUMENTS` rewritten). `ai/review` is the label-triggered `claude-review.yml`, added only with `--review claude` (`--review-model` fills `{{reviewModel}}`) |
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
Who commits depends on the scope: [AGENTS.md § Coordinating window](AGENTS.md#coordinating-window).

## User-facing lines

Beyond the lore rule above: a low or partial reading names what would raise it, so it does not read
as a failure where nothing failed. Check a line by reading it as the person in the exact state that
prints it, and ask whether a fast reading inverts the action they should take next. When one symptom
has several causes and the evidence in hand already carries one cause's signature, the line states
that cause instead of listing the others as guesses. Two renderings of one value (plain and lore,
text and `--json`) are projections, not duplication. "Engram" is a lore name with no fixed meaning:
engineering documents neither define nor use it; the per-run record is the run record
([architecture/run-record.md](architecture/run-record.md)), and `construct.json` is the model.

## Citing and recording

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
- A pull request of an owner-merged kind: gate it locally the same way, commit, push and open it; the
  owner merges. It is ready when CI on its current head is green, and that is the whole definition:
  ready is derived from CI, never announced as an event of its own. A later push, a merge of `main`
  into the branch included, makes a new head, and the pull request is ready again only once CI on that
  head is green. `pnpm board` derives ready the same way.
- A change to the owner's machine — installing or upgrading anything outside a worktree (`brew`, `pipx`,
  `npm i -g`, a Poetry or conda environment, a global config) — happens only after the owner's explicit
  yes. An instruction to use a tool is not permission to install it: name what is missing and the
  command that would install it, and wait.

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

A question about the state of the work — "status", "what's there", "where are we", in any language — is answered as
`/status` answers it ([.claude/commands/status.md](.claude/commands/status.md)). Every report on the state of tasks
starts from `pnpm board` (`pnpm board --json` for the window's own reading), never from the session's memory of them.

## Choosing the contour: cheap path or ladder path

The principle is *The cheapest contour that gives the required proof* in
[architecture/principles.md](architecture/principles.md), and the first step of `/plan`
([.claude/commands/plan.md](.claude/commands/plan.md)) applies it: for each new task the contour is
chosen before anything else, the cheap path (an ordinary session in its own worktree, `pnpm run
quality`, a pull request and CI, with no brief, witnesses, mutations or Ghost) or the ladder path (a
brief, witnesses and a Ghost). What fits each is listed there and not repeated here. The ladder is
not the default, and the cheap path keeps its discipline: CI and
[architecture/owner-merges.md](architecture/owner-merges.md) apply to it unchanged.

The journal, which lives outside the repository, gets one line per task naming the path and why it
was chosen: `{"event":"path","task","path","reason",…}`, with `path` either `cheap` or `ladder`.
`pnpm board` reads these lines. A cheap task also records `verification`: one word for the mechanism
that produced the knowledge its result stands on (E9 in [architecture/code-matrix.md](architecture/code-matrix.md)) —
`measurement`, `code-reading`, `run`, `review`, `mutation`, `browser` or `human-gate`. A task whose
outcome is a report and not a pull request records `report` with the report's path instead of `pr`.

Morse is not introduced, and the classification is not designed in advance.

After every Ghost, a `scan` agent first runs a blind Design check (about two minutes). A blocker → a new attempt without a full review; none → the ordinary review.
This step is a trial until the first three Ghosts after 2026-09-28 have been through it; then the owner
keeps, changes or drops it.

## Ghosts

A Ghost, a ladder run in a session of its own, is started only by `pnpm ghosts:launch`, which checks
the owner's approval against the brief's hash (`pnpm ghosts:hash`). There is no hand route around it.
Approving a brief's hash is the permission to launch: the coordinating window then launches the Ghost
itself, after a dry run of `pnpm ghosts:launch` answered with anything but `yes`, which prints the
decision and opens nothing.
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

A report on a pull request that changes `src/` or `templates/` ends with the compact matrix described in
[architecture/code-matrix.md](architecture/code-matrix.md), over its four common rules and any the brief declares;
on one that changes only `scripts/`, the matrix is optional.

Mutations go only through `construct mutate apply` / `judge` (read `construct mutate --help` for the
current flags), never through a hand-rolled copy and restore, and a red-on-base check runs in a
disposable worktree, never by swapping files in the ladder's tree. A changed test is shown intact by a
mutation it caught before the change, run on the old and the new version with the prediction written
first; an agent's reading that a test was not weakened is not a witness. When an allow-list or an
accepted set grows, construct the case the growth could mask and run it.

The coordinating window gives the verdict. A small divergence from the brief is merged, with a
follow-up issue that names it. Opening an issue is never forbidden, but once more than ten are open,
the evening triage takes each one: close it, fold it into a wave, or drop it.
