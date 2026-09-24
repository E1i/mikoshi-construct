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
| `scripts/` | The harness this repository materialized for itself and then grew: `composition/` and `model/` (check + render for the two kinds of diagram), `privacy/` (no home path or unlisted domain in a published artifact), `docs/` (every anchored nav link resolves to a rendered heading), `release-notes/`, `release/`, `bench/` (the architect benchmark), `construct/implement.workflow.mjs` (the `/implement` ladder), `tests/` |
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
