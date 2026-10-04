# CLI reference

Every command, every flag, and what each one exits with. The short version lives in
[README.md](https://github.com/E1i/mikoshi-construct#usage).

```bash
npx mikoshi-construct <command> [options]   # no install
construct <command> [options]               # after a global install
miko <command> [options]                    # same binary, fewer keystrokes
```

`construct`, `miko` and `mikoshi-construct` are the same executable.

## Options every command takes

| Option | Default | What it does |
|---|---|---|
| `--dir <path>` | `.` | The repository to act on. Created if it does not exist. |
| `--plain` | `false` | No colour, no lore, no emoji. Use it in CI and in scripts. |
| `--johnny` | `false` | A second palette and a different greeting. Cosmetic. |

Colour also turns itself off when `NO_COLOR` is set or when stdout is not a terminal.
Flags accept either spelling, so `--dry-run` and `--dryRun` both work.

### A construct.json from a later build

`construct.json` declares an integer `manifestVersion` describing its own shape, separate from the
CLI version that wrote it ([decision 0009](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0009-the-manifest-carries-its-own-schema-version.md)).
A manifest written by an older CLI is normalised on read. A manifest declaring a version **higher**
than this binary understands is neither read nor normalised: the command reports one line naming the
version it found, the version it understands, and that the CLI needs upgrading, then exits `1`.

```
construct.json declares manifestVersion 6, and this binary understands 5.
Nothing was read and nothing was written: upgrade the CLI and run this again.
```

This reaches `doctor`, `sync`, `init`, and `cost` where no environment variable already names the
runtime. `graph` draws from `construct.model.json` and never reads the manifest, so it cannot meet
this state. Nothing is written in any of these cases, so running an older CLI against a newer
repository cannot damage it.

## construct init

Detects the repository, asks what neither a flag nor an existing `construct.json` answers, then
writes the construct: architecture policy,
the harness, an API contract where the preset has one, and the agent instructions. It ends by naming
what to run next — install and the harness where it wrote a package manifest, the harness alone where
it changed other files, and nothing at all where it changed none.

| Option | Default | What it does |
|---|---|---|
| `--preset <id>` | asked | `node-backend`, `node-frontend`, `node-library` or `monorepo`. |
| `--ai <target>` | `claude` | `claude`, `cursor` or `both`. Decides whether you get `.claude/`, `.cursor/rules/` or both. |
| `--name <name>` | directory name | The project name written into `package.json` and the agent files. |
| `--review <provider>` | `none` | `claude` adds the label-triggered review workflow. It needs a `CODE_REVIEW_API_KEY` secret. |
| `--review-model <model>` | `claude-sonnet-5` | The model that review workflow runs. |
| `--yes`, `-y` | `false` | Ask nothing. Take the defaults and skip the confirmation. |
| `--dry-run` | `false` | Print the plan and write nothing. |

Without `--yes` and with a terminal attached, `init` asks only for what the flags and the record leave
open. Piping input without `--yes` is refused rather than guessed at.

Exits `0` when it writes or when `--dry-run` finishes, `1` when you decline the confirmation, when
the target cannot be read, or when the preset contradicts the stack the detector found.

Every preset today is a Node preset. A directory with another ecosystem's manifest at its root
(`go.mod`, `Cargo.toml`, `pyproject.toml` and the others `soulkill` lists) and no `package.json` is
refused before anything is written, with a line that names the preset and the manifest:

```
Refused: --preset node-backend is a node preset, and this directory has go.mod and no package.json; nothing was written.
```

A `package.json` beside the other manifest makes Node part of the stack, and init proceeds.

A repository with `.construct/attach.json` is refused before anything is written, whatever the file holds: `construct detach` first.

### A new project

```bash
mkdir my-service && cd my-service
npx mikoshi-construct init --yes --preset node-backend
pnpm install
pnpm run quality
```

The harness is green before you write a line. That is the point of the preset: the contract, the
composition model and its rendered diagram, the lint policy and the tests all ship consistent with
each other.

### An existing repository

Look before you write. `--dry-run` prints the plan and touches nothing:

```bash
npx mikoshi-construct init --preset monorepo --dry-run
```

```
  ~ package.json (merge)
  = eslint.config.mjs — exists, review manually
  + architecture/principles.md
  + .claude/commands/construct-discover.md

  Sample sources omitted: the directory is not empty. Discovery maps what is already here.
```

Three markers tell you what will happen. `+` creates a file that is not there. `~` merges into one
that is, and only inside a `construct:begin … construct:end` block or as a JSON merge where your
values win. `=` leaves the file alone and reports it. An existing repository never receives example
code, and there is no `--force`.

### Running init again

The closing line reports two counts, because they answer two questions: how many write operations the
run applied, and how many of those left a file different from what was there. A second run typically
reads `4 files, 0 changed` — the merges and appends were applied and produced exactly what was
already on disk. The same changed count decides whether the run names a next step at all, so the two
lines cannot disagree.

A second `init` asks nothing `construct.json` already answers. The preset, the agent target, the
project name and the code-review provider are all recorded there, so a re-run reads them and names
them in the configuration block instead of putting the same four questions again. A flag still
overrides any of them, and the change is reported like any other change to a recorded value. The one
question that survives is the confirmation before writing — it authorises this run, which no record
can do on its behalf.

The claims the model carries are read the same way. Whether the preset's sample belongs to this
repository is answered by whether the construct ever materialized it here, which `construct.json`
records, rather than by whether the directory is empty — which is false from the second run onward,
and used to delete the `lint-policy` claim from `construct.model.json` on every re-run.

The workspace policy is read the same way, and it is the one place where a fact and a decision shared
a variable. Which packages exist is a fact about the tree and is re-derived on every run, so a
package added since the last one becomes a new key. What each package may import is a decision: once
it is in the record it is kept, and a new key is given the preset's default for a package of its kind
— a package under `apps/` may import every other workspace package, anything else may import nothing.
The run names the keys it added, what each may import, and that `eslint.config.mjs` is not rewritten
here, so a later `construct sync --apply` would write the new policy into it
([decision 0026](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0026-which-packages-exist-is-derived-what-they-may-import-is-recorded.md)).

`AGENTS.md` and `CLAUDE.md` ship in two forms: the full document the construct writes when it creates
the file, and the shorter block it writes into a file that was already there. A second `init` keeps
the form recorded for that path under `variants` in `construct.json` rather than choosing again from
whether the file exists — by the second run it always exists, and choosing on that alone replaced a
document the construct had written with the form meant for someone else's. Where no run ever recorded
a form — a `construct.json` older than the `variants` record and never synced — the shorter form is
still chosen, as before, because nothing on disk settles which one wrote the block.

### Choosing the agent

```bash
npx mikoshi-construct init --yes --preset node-frontend --ai both
```

The rules are written once and rendered for each target. Claude Code reads `.claude/rules/*.md` with
`paths:` frontmatter; Cursor reads the same rules as `.cursor/rules/*.mdc` with `globs`. The
discovery protocol ships as `/construct-discover` for Claude Code and as an agent-requested rule for
Cursor.

### Pull request review

```bash
npx mikoshi-construct init --yes --preset node-backend --review claude --review-model claude-opus-5
```

Adds `.github/workflows/claude-review.yml`, which runs when you put the `claude-review` label on a
pull request. Add a `CODE_REVIEW_API_KEY` secret to the repository or the workflow will not start.

### What init records in construct.json

`construct.json` is the record of the run that wrote it. `manifestVersion` is an integer naming the
shape of this file and nothing else; `construct` is the CLI version that ran. They are separate on
purpose — a product version is bumped for reasons that have nothing to do with the file's shape, so
branching a migration on it is a question the file cannot answer. An older manifest is normalised when
it is read and never written back.

| Key | What it holds |
|---|---|
| `manifestVersion` | The integer schema version of this file. |
| `construct` | The CLI version that wrote it. |
| `createdAt`, `preset`, `ai`, `review` | What the run was asked for. |
| `harness`, `report`, `contracts`, `vars` | The harness command, the contract paths and the resolved template variables. |
| `files` | One sha256 per file that run declared writing. |
| `variants` | For each `append-block` target, which template form wrote it: `default` where the construct created the file, `existing` where the file was already there. |
| `blocks` | For each `append-block` target the run wrote, the sha256 of the construct block's owned view (discovery bodies left out) and a snapshot of the `vars` it was written with, so `sync` can tell an edited block from an edited record. Measured at the write and never back-filled: a record from before manifest version 6 carries none. |
| `policy` | The workspace import policy as structure, not as rendered source: one entry per package directory naming what it may import. What a run renders into `eslint.config.mjs` follows this, never the other way round. |
| `discovery` | Where each marker lives, and who wrote it. |

```json
{
  "manifestVersion": 2,
  "construct": "0.1.3",
  "discovery": {
    "baseSha": "9f1c0b7e1b3b9f0e2a4c6d8e0a2b4c6d8e0a2b4c",
    "filledAt": "2026-09-17T09:12:44.118Z",
    "markers": {
      "product": {
        "file": "AGENTS.md",
        "authoredBy": "construct",
        "sha": "a8c99232614a6bd1e6cc527a39dea9a39e093d3b24e306ac38bfa55d73294a50"
      },
      "composition": { "file": "architecture/composition", "authoredBy": "unknown", "sha": null }
    }
  }
}
```

`init` writes every marker as `unknown` with no sha: it fills no marker, so it claims none. The two
fields move together and the record carries no third combination: `construct` always comes with the
sha of the body that run wrote, `unknown` always with `null`. A `construct` recorded with no sha is a
record from no run the tool can have made, and reading `construct.json` turns it back into `unknown`
with `null` rather than carrying it forward as a fourth shape.

`/construct-discover` records `baseSha` — the commit the run started from — when it starts, `filledAt`
when it finishes, and for each marker it fills the file, `authoredBy: "construct"` and the sha256 of
the body it wrote. The body is the text between the two `construct:discover` comments, trimmed; for
`composition` it is every `*.yaml` in the directory, sorted by name, each as its filename, a newline
and its contents. Nothing is written into the prose of a marker: a document people read does not carry
machine bookkeeping, and the one place an owner is most likely to edit is the worst place to keep the
record.

### What doctor reads a marker as

`authorship` is derived on every read from the recorded provenance and the body found in the file, and
never stored. The four readings are distinct states and not one state with a flag, because the repairs
differ:

| reading | what it means |
|---|---|
| `construct` | provenance was recorded and the body still hashes to the recorded sha, so the marker is still the construct's own words |
| `owner` | provenance was recorded and the body no longer matches it: the marker has been edited since, and reads as the owner's. There is no command to run — the edit is the evidence |
| `unrecorded` | no provenance was recorded for this marker, so there is nothing to compare a body against. It says nothing about who wrote the body |
| `unreadable` | provenance was recorded, and the file or directory holding the body could not be read here |

All four are reported. `unrecorded` and `unreadable` are the two ways a comparison could not be made,
and they are kept apart because one is answered by a discovery run recording what it wrote and the
other by the missing file.

**An `unrecorded` marker is not repaired by writing a sha for it**, and the gap in the record is not a
backlog. A sha asserts that the body it hashes is what that run wrote; computing one over a body
nobody recorded asserts authorship of text whose author is exactly what is unknown, and turns *never
looked* into *checked and matching*. The body of an `unrecorded` marker may be the construct's from an
earlier run or the owner's own edit since, and nothing on file distinguishes them — which is what
`unrecorded` says. Provenance is written only by the run that writes the body: a discovery run records
it for the markers it fills, a marker it did not fill keeps the entry it had, and `unrecorded` stays
until a run rewrites that marker. It is the honest reading of the record, not a defect in it.

## construct doctor

Checks that the construct is intact: every file the manifest recorded is still present, the harness
script `construct.json` names is still there where that command is a package script, the contract paths it records still resolve, and each
discovery marker is either filled or named as missing. It then answers a second question —
what this tool claims about the repository, at what level each claim is enforced, and whether the
facts under it still hold — and ends with one line naming where the first chain stops.

### Two families, two authorities

The result splits in two, and the line between them is
[decision 0016](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0016-the-model-is-the-source.md).
The **provenance** family is read from `construct.json`, the authority for what `init` and `sync`
wrote. The **knowledge** family is a projection of `construct.model.json`, the authority for what
this tool holds to be true about the repository; `doctor` holds no state of its own there — a
verdict's level is the claim's `enforcement.level`, its state is the state derived from the facts
that claim stands on, and where you are is the model's own path selection.

| Field | Family |
|---|---|
| `ok` | provenance |
| `missingFiles` | provenance |
| `movedFiles` | provenance |
| `modifiedFiles` | provenance |
| `unreadableFiles` | provenance |
| `missingDiscovery` | provenance |
| `provenance` | provenance |
| `harness` | provenance |
| `harnessProblems` | provenance |
| `uncollectedTests` | provenance |
| `warnings` | provenance |
| `checks` | knowledge |
| `hypotheses` | knowledge |
| `youAreHere` | knowledge |
| `notCarried` | knowledge |
| `versionGap` | provenance |

`harnessProblems` carries provenance only: `package.json` is gone, it has no script under the name
`construct.json` recorded, or a contract path that manifest points at is absent. Each of those goes
false only when what `init` installed changed. Whether the harness command really runs its steps is
knowledge — the owner's `package.json` can drop `pnpm lint` with no construct file touched — so it
is the `harness-steps` claim, rendered as a verdict like any other.

`harness` names the command `construct.json` recorded and whether anything observed it running this
repository's own verification surface ([decision 0033](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0033-checked-means-the-target-was-verified.md)).
Its `state` is the projection of the verification stage of the claim `harness-covers-target`, which
only discovery writes: the construct never does. That stage stands on a `report-covers` fact — a
runner's report and the surface globs, minus every path `construct.json` records as the construct's
own.

A `report-covers` or `report-misses` fact carries a `format`: `vitest-json` (the default, read when
`format` is absent) for a Vitest `--reporter=json` report, or `junit-xml` for a JUnit XML report.
Point one at a pytest suite by running `pytest -o junit_family=xunit1 --junitxml=<path>`, the xunit1
shape the reader understands, and record that `<path>` as the fact's `path` with `"format":
"junit-xml"`. A testcase's repository path comes only from its `file` attribute; one with no `file`
is unmapped, and coverage through it reads `unknown`. A `<skipped>` testcase did not run; `<failure>`
and `<error>` did.

| `state` | Meaning |
|---|---|
| `checked` | The report lists at least one surface file as executed. A failed file was run; a skipped one was not. Whether the harness passes is not said. |
| `does-not-cover` | The report is complete, newer than every surface file, every entry in it maps to a repository path, and none of the surface files was executed. |
| `unknown` | Anything else: no `harness-covers-target`, no report, a report older than a surface file, an entry that maps to no repository path, or a surface that matches no file. |

`checked` no longer means the command is a package script. Whether `package.json` still carries the
recorded script is `harnessProblems`, unchanged. Neither `does-not-cover` nor `unknown` makes `ok`
false.

That move changes what is rendered and not what is exited on: **a harness that no longer runs lint
is an unsupported claim, not a problem**, and it leaves `ok` exactly where it was, because `ok`
answers whether the inspection completed. No repository changes which side of `ok` it falls on.

The classification lives in `src/commands/doctor/families.ts`; this table is its second reader and a
test fails when the two diverge.

### A file that exists and cannot be read

`unreadableFiles` names each recorded path that is there and that `doctor` could not read, with the
cause the operating system gave in parentheses — a directory standing where a file is expected, a
permission it does not have, a broken link, malformed JSON where a manifest is recorded. There is one
category and no branch per cause: the reading either succeeded or it did not, and which of them it
was travels in the entry rather than in a second code path.

`movedFiles` lists a recorded path that is gone from disk while the path today's templates write in
its place is present (`scripts/construct/implement.workflow.mjs` → `scripts/construct/implement.workflow`).
It is not `missingFiles` and does not make `ok` false: the file moved, and `sync --apply` records
the new path the next time it writes.

Such a path is not `missingFiles` — it exists — and not `modifiedFiles` — nothing was compared — and
reporting it as either would be a claim about a file `doctor` never opened. It makes `ok` false: the
question `ok` answers is whether the construct is intact, and a file the command could not read is a
part of the tree it cannot answer for. Catching the error without reporting it would be worse than
crashing, because the file would leave the inspected set in silence.

### Two kinds of `unknown`, and which one moves `ok`

`ok` is a **provenance** answer, and only that: it says whether the construct's own installation is
intact and fully inspectable. It says nothing about what is claimed of the repository — a claim that
stops being held is reported in `checks` and never moves the exit code.

Within that scope it collapses a three-valued world toward inspection rather than toward confidence.
A part of the tree the command could not open is one it cannot answer for, and the opposite choice
would put a quiet false calm into an exit code, which is where it would do the most damage.

That makes the two origins of `unknown` behave differently, and the difference is deliberate rather
than incidental:

| Origin | Meaning | `ok` |
|---|---|---|
| Obstruction — asked to read, could not | the inspection is incomplete | **false** |
| No subject — no model, or no fact named under a claim | there was nothing to inspect, and the answer is complete | **true** |

The first says *I could not*; the second says *I have nothing to say*. Only the first is a gap in the
run. A repository carrying no `construct.model.json` therefore gets no verdicts, and `ok` is
unaffected — the command completes, the provenance family answers as it always did, and a repository
that simply predates the model is not reported as broken.

### Three ways to carry no claim, and a line for each

Having no model at all, carrying a model that names no claim, and carrying claims whose chains all
hold are three different readings. `youAreHere` says which one it is rather than leaving that to be
inferred from an empty `checks` list: `at` is the discriminant, and `stop` is carried only under
`at: "stop"`.

| `at` | What it says | The line it prints |
|---|---|---|
| `no-model` | There is no `construct.model.json` here: nothing was read, so nothing is known about what this repository claims. This is not a reading that nothing is enforced. | `You are here: nowhere to place you — there is no construct.model.json, so nothing is known about claims` |

Under `no-model` the Enforcement section adds one further line, once, naming what writes the file: `One is written by construct init, which is additive and overwrites nothing it does not own. Nothing forces you to have one.` The three readings of the absence are unchanged — the sentence is added beside them, not in place of one, because the absence is a state to explain rather than a fault to repair.

**A model this binary cannot read is not one of these readings.** Where `construct.model.json`
declares a `modelVersion` above what the running binary understands, the command reports that state
and exits `1` — it does not reach `no-model`, and it does not offer `init`, which would propose
overwriting the file it could not read
([decision 0028](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0028-a-model-ahead-of-the-reader-is-a-state.md)).
A version *below* this binary's is a malformed document and is reported as one; nothing migrates an
older model.

| `no-claim` | `construct.model.json` was read and names no claim: it asserts nothing about this repository. | `You are here: construct.model.json carries no claim, so there is none to place` |
| `no-stop` | The model carries claims and none of their chains stops before its end. | `You are here: no claim stops before the end of its chain` |
| `stop` | The first claim whose chain stops, carried under `stop` with the stage and the facts behind it. The line names the **first** fact the stage declares in its `supportedBy` — the same declared-order key that breaks a tie between claims, so the line is stable between runs and diffs — and counts the rest, so it stands on its own where it is read apart from the section above; the full list stays in the verdict. A stage that could not be read names no fact: nothing was established about it, so there is nothing that stopped matching to name. | `You are here: <claim> — <stage> unsupported: <fact> no longer matches, and 2 more` |

Under the first two the Enforcement section says why it lists nothing, instead of an empty list a
reader would take for a repository that was looked at and found clean. None of the four moves the
exit code: a repository with no model exits `0`, because absence of a subject is not obstruction.

### What the model holds open

`hypotheses` carries one entry per hypothesis in `construct.model.json`, in the model's declaration
order, each with the `statement` discovery wrote, the commit it was read from (`baseSha`), whether the
files under it were committed when they were read (`evidenceClean`) and the state derived from the
facts named under it — the same derivation the claims
use, so a hypothesis reads `held`, `unsupported` with the paths that no longer match, or `unknown`.

`unknown` keeps its two origins apart here as everywhere else. A hypothesis whose facts could not be
read carries `reason: "unevaluable"` and the paths it could not read; a hypothesis with nothing named
under it carries `reason: "no-fact-named"`, and the report says so in as many words rather than
letting it read like a fact that failed. Neither moves the exit code: a hypothesis is what the
repository was taken to be, not something it promises.

An empty list is not a repository whose readings all stand. The section names which of the two it is
— there is no model at all, or the model was read and holds nothing open — the same way `youAreHere`
does for claims.

`evidenceClean: false` says the files that hypothesis's own facts name carried uncommitted changes when
discovery read them — the evidence under it is in no commit, not that the hypothesis is doubtful — and
the line for it says that beside the reading. It speaks of those files only, never of the tree around
them.

| Option | Default | What it does |
|---|---|---|
| `--json` | `false` | The full result as JSON, for CI. |

```bash
npx mikoshi-construct doctor
```

```
[warn] WARNING: Discovery incomplete.

    Missing:
      product
      module-map
      composition-roots

    Run: claude → /construct-discover
  Materialized by construct 0.1.0, read by 0.2.0.
  The baseline moved on: 3 recorded paths a sync would add or update — run `construct sync`.
[ok] OK

Discovery provenance
  commands             AGENTS.md
  Unchanged since discovery wrote them: 1 marker nobody has stood behind yet.
  composition-roots    AGENTS.md
  Edited since the sha was recorded: 1 marker now reading as yours rather than the construct's.
  No provenance recorded: 1 marker with nothing recorded to compare a body against.

Enforcement
  no-committed-secret                  L3  held         .github/workflows/security.yml runs gitleaks over the history …
  vulnerable-dependencies-are-visible  L3  held         security.yml runs pnpm audit weekly and on pull requests …
  ci                                   L3  unsupported  expects .github/workflows/ci.yml runs pnpm run quality … — no longer matching: .github/workflows/ci.yml
  harness-steps                        L3  unsupported  expects .github/workflows/ci.yml runs pnpm run quality …, and package.json … — no longer matching: .github/workflows/ci.yml
  lint-policy                          L3  unsupported  expects scripts/tests/lint/syntax-policy.test.ts asserts … — no longer matching: .github/workflows/ci.yml
  doctor executes nothing from the repository it inspects, so it does not speak about whether the harness passes.

You are here: every-change-passes-the-harness — enforcement unsupported: .github/workflows/ci.yml no longer matches
```

Unfilled markers are reported but do not fail the command, because discovery is the agent's job and
the harness has to stay usable before it runs. Exits `1` only when a baseline file has gone missing
or the harness is broken. Files you have edited since `init` are expected and counted, not faulted.
A low level is information, not a failure: levels, states and the you-are-here line never change the
exit code.

### The baseline's own version

Beside the baseline, `doctor` names the version that materialized the repository, the version reading
it now, and how many recorded paths a `sync` would add or update. That count is not a second opinion:
`doctor` replays today's templates through the same classification `sync` runs and counts the paths
classified `add` or `update`, so the number it prints and the number `sync` acts on cannot drift. A
replay it cannot run — a manifest missing a variable today's templates render, for instance — reads
as "cannot be established" rather than as zero.

It is evidence on the baseline check, not another gate: it has no level, it is not part of where you
are, and it never changes the exit code. A baseline that has moved on is work that became
available with a release, not a fault in the repository. `--json` carries it as `versionGap` with
`materializedBy`, `readBy` and `pending`, where `pending` is `null` when the replay could not run.

### What doctor does not do

`doctor` executes nothing from the repository it inspects: no child process, no dynamic import of a
path inside it, no `require` into its `node_modules`, no call into its ESLint or Vitest APIs. It is
run through `npx` in a fresh clone, before anyone has decided whether that code is trustworthy, and
a flat ESLint config is a module — resolving it would run the audited repository's own code on the
instruction "check whether this repository is honest". Every verdict below is derived from reading
file text: the paths the facts in `construct.model.json` name, the files `construct.json` records,
`package.json` and the runner config the record carries.

Two consequences follow. `doctor` never reports `L4`: branch protection and organisation rulesets
live in the GitHub API, not in the repository, so the most a file can show is `L3`. And the blind
spot is a stated boundary rather than a synthesised verdict: the report says in one line that
`doctor` executes nothing from the repository it inspects and therefore does not speak about whether
the harness passes. There is no `red-gate` verdict — a claim nobody made is not `doctor`'s to
report. See
[architecture/decisions/0007-doctor-executes-nothing.md](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0007-doctor-executes-nothing.md).

### The levels

| Level | Meaning |
|---|---|
| `L0` | Text, or a command nobody is obliged to run. |
| `L1` | A human in review. |
| `L2` | Local: a git hook, bypassable with `--no-verify`. |
| `L3` | CI that does not block a merge. |
| `L4` | CI that blocks a merge. Never reported by `doctor`. |

Every level above L0 presumes a mechanism that **can report a failure**. L3 and L4 differ over
whether a failure blocks a merge; L0 and L3 differ over whether a failure can be raised at all. A
check that is green whether or not the invariant holds reports nothing and is L0, however much
machinery stands behind it.

### The checks

Each check returns `{id, claimId, level, state, authoredBy, mechanism}`, plus what the state knows:
`doesNotHold` where the state is `unsupported`, and `reason` — `unevaluable` with `unevaluable`, or
`no-fact-named` — where it is `unknown`. **There is one check per claim the model carries, in the
order the model declares them** — the section is the whole model or it is not a projection of it.
Every one of those values is read from the claim `claimId` names: `level` is its
`enforcement.level`, `mechanism` its `enforcement.mechanism`, `authoredBy` its author in the model —
`construct`, `discovery` or `unknown`, and never derived from anything else — and `state` is the
state the facts that enforcement stands on resolve to, one of `held`, `unsupported` or `unknown`.

`mechanism` is what the claim **expects**, never a reading of what is the case, and the report
renders it that way: beside `unsupported` it is prefixed as an expectation and followed by the fact
paths that no longer match, so no line can name a state and a positive assertion in the same breath.
The facts are a required argument of the call that renders a verdict that is not held, so a line
without them cannot be built.

`id` is the claim's own id, except for the two claims that carry a legacy check id in the model so
that consumers written against the previous shape keep reading: `every-change-passes-the-harness`
renders as `ci`, and `lint-policy` as `lint-policy`. `claimId` is always present and is the only
identifier worth matching on.

| State | Meaning | What the line names |
|---|---|---|
| `held` | Facts are named, every one was evaluated, and every one holds. This says the facts still match, not that the level is proven: the facts under a claim are necessary conditions, never sufficient ones. | The mechanism the claim expects. |
| `unsupported` | Facts are named, every one was evaluated, and at least one does not hold. This says the facts no longer match, not that the enforcement is gone. | `doesNotHold`: each fact path that no longer matches, beside the mechanism the claim expects. |
| `unknown` | No fact is named, or a named fact could not be read. Not having looked is not evidence of absence. | `reason: "unevaluable"` with the paths that could not be read, or `reason: "no-fact-named"`. There is no failing fact in this state and none is named: a fact nobody could read is never reported as one that does not hold. |

| `id` | The claim it renders | When it appears |
|---|---|---|
| `no-committed-secret` | `no-committed-secret` | Only where the construct wrote `.github/workflows/security.yml`, the workflow its facts name, and the facts it names hold when the model is written. Absent from the output otherwise, rather than reported as missing |
| `vulnerable-dependencies-are-visible` | `vulnerable-dependencies-are-visible` | Only where the construct wrote `.github/workflows/security.yml` and the facts it names hold when the model is written |
| `ci` | `every-change-passes-the-harness` | Only where the construct wrote `.github/workflows/ci.yml` and the facts it names hold when the model is written. A repository whose CI its owner wrote carries no such claim: the construct never read that workflow and cannot say it runs the harness |
| `harness-steps` | `harness-steps` | Only where the construct wrote both `.github/workflows/ci.yml` and the `quality` script in `package.json` that its facts name, and those facts hold when the model is written |
| `lint-policy` | `lint-policy` | Only where the model carries that claim, which is where the preset's sample was materialized and the construct wrote the policy test it stands on. Absent from the output otherwise, rather than reported as missing |
| `a-breaking-api-change-is-named-before-it-ships` | the same claim | Only where the preset materializes an HTTP contract |

A preset that declares no syntax policy makes no `lint-policy` claim, so no verdict is rendered for
it: the construct required nothing there, and announcing the absence of something nobody required
would be a finding about a task. `node-library` is such a preset — its harness is the shared ESLint
configuration with no restriction of the construct's own.

### Claims this preset can make and this repository does not carry

Where a claim the preset **can** make is absent from `construct.model.json`, `doctor` names it in a
block of its own, after the enforcement trace and before the hypotheses:

```
Not claimed here: this preset can make these and this repository does not carry them. They have no
level, because nothing is enforced by a claim that was never made.
  no-committed-secret — .github/workflows/security.yml does not carry what it would stand on.
  lint-policy — scripts/tests/lint/syntax-policy.test.ts does not carry what it would stand on.
```

The set is **derived on every read** and stored nowhere: `construct.json` records the preset and the
vars, the claims that preset can make are rebuilt from them, and whatever the model does not carry is
compared against the tree by the same machinery that evaluates the claims it does. So the reading
follows the tree the moment the tree changes, rather than repeating what was true at `init`
([decision 0024](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0024-an-absent-claim-is-derived-not-recorded.md)).

Each line carries one of four readings, which `--json` names under `reading`:

| `reading` | What it says | What the line carries |
|---|---|---|
| `does-not-hold` | A fact the claim would stand on was read and does not hold. | `path`: the first such fact's path. |
| `unevaluable` | A fact the claim would stand on could not be read, so whether it would stand cannot be determined. | `path`: the first such fact's path. |
| `every-fact-holds` | Every fact holds and a run here would write the claim, so running `init` again records it. | Nothing further: no fact is outstanding. |
| `sources-omitted` | Every fact holds and **no** run here writes the claim: it stands on the preset's sample sources, which the construct never materialized into this repository and materializes only into an empty directory. | Nothing further: no fact is outstanding. |

The last two are kept apart because the promise in the first is a promise about a run. `lint-policy`
is today the only claim a preset makes from its sample, so it is the only one that reads
`sources-omitted`; a repository that writes its own `scripts/tests/lint/syntax-policy.test.ts` makes
every fact under it hold and still carries no such claim, because the construct never wrote the sample
there and `init` writes it only into an empty directory. Where the construct *did* materialize the
sample, a run here would record the claim — so a tree whose owner deleted it from the model reads
`every-fact-holds`, and running `init` again puts it back.

An absent claim **carries no level and is not a verdict**: nothing is enforced by a claim that was
never made, and it changes no exit code. Where the tree carries every claim its preset can make, the
block is not printed at all. A claim the preset cannot make is never named — `node-library` and
`lint-policy` above — because that would be a statement about the preset dressed as one about the
repository.

On a repository whose owner wrote their own `ci.yml` and `security.yml`, these lines appear on
**every** run until the facts under them hold, at which point the reading becomes `every-fact-holds`
and a second `init` records the claim. On one adopted without the preset's sample, `lint-policy`
never leaves the block at all: the reading moves from `does-not-hold` to `sources-omitted` when the
policy test appears, and no further. That is intended: the statement is true while it is true.

Two verdicts that existed before this version are gone rather than renamed. `hook` reported that no
hook manager was installed, which no preset installs and no claim requires. `red-gate` reported
`doctor`'s own limit as a verdict about the repository; that limit is now a stated boundary in the
report, which is what a blind spot is.

### The tests the runner does not collect

`uncollectedTests` names the `*.test.ts` files `construct.json` recorded that fall outside the
include globs of the runner config — read literally, never executed. It is provenance, not
knowledge: both ends were installed by `init`, so it becomes false only when what `init` wrote
changed. It is reported **only when the runner config itself appears in the manifest's recorded
files**. Where a repository arrived with its own vitest or vite config the construct never wrote that
end, and a verdict there would pronounce on a file its owner owns, so the list stays empty and says
nothing. A non-literal include leaves it empty for the same reason, and a runner config that cannot be read
leaves it empty and is named in `unreadableFiles`.

A repository that already had its own `eslint.config.mjs` keeps it: `init` never overwrites a file the
construct did not write. The construct's syntax policy is therefore not applied there, and the test
that proves the policy fires — `scripts/tests/lint/syntax-policy.test.ts` — is materialized only into a
directory that was empty at `init`, because it asserts the construct's selectors and an owner's
configuration is free to declare a narrower policy or none. No `lint-policy` verdict in such a
repository is a true reading of it, not a missing file, and the report is the place that can tell the
two situations apart.

An owner who wants the policy adopts it deliberately: materialize the same preset into an empty
directory (`npx mikoshi-construct init --yes --preset <id> --dir <tmp>`), copy the `no-restricted-syntax`
blocks from its `eslint.config.mjs` into your own configuration keeping the roles in order from
broadest to most specific, copy `scripts/tests/lint/syntax-policy.test.ts` next to it, make sure the
test runner's include globs reach `scripts/tests/**`, and run the harness. `doctor` reports
`lint-policy held` once the facts under that claim hold.

Typecheck is not a check. Where a bare `tsc --noEmit` cannot carry a stack, the preset contributes a
line to `warnings` instead — a framework matrix would grow faster than it could be closed.

The last line names where you are: the first claim whose chain stops, the stage it stops at —
`enforcement` before `verification` — and the state it stops in. `doctor` does not work that out;
`selectPath` in the model does, so the same model always yields the same answer, tie-break included.
Where there is no chain to stop — no model, or a model naming no claim — the line says which of the
two it is rather than reading as a repository whose every claim holds.

### Who each marker belongs to

`doctor` derives authorship rather than storing it. A marker whose body still hashes to the sha
`construct.json` records for it reads as `construct` — the repository is still quoting the tool back
to itself. A marker whose body no longer matches reads as `owner`: someone edited it by hand, and that
edit is the only evidence needed, so there is no command to run and nothing is written back. A marker
with no recorded provenance reads as `unknown`, which is what every marker of a repository initialised
before provenance existed reads as — a manifest that recorded nothing is no evidence that the tool
wrote the prose.

The report names the `construct` markers and nothing else; `provenance` in `--json` carries one
reading per marker. This is information: provenance is not a check, it has no level, and it
never changes the exit code.

```json
{
  "schemaVersion": 1,
  "ok": true,
  "missingFiles": [],
  "movedFiles": [],
  "modifiedFiles": [],
  "unreadableFiles": [],
  "missingDiscovery": ["product", "module-map"],
  "provenance": [
    { "marker": "product", "file": "AGENTS.md", "authorship": "unrecorded" },
    { "marker": "commands", "file": "AGENTS.md", "authorship": "construct" },
    { "marker": "composition-roots", "file": "AGENTS.md", "authorship": "owner" }
  ],
  "harness": { "command": "pnpm run quality", "state": "checked" },
  "harnessProblems": [],
  "uncollectedTests": [],
  "warnings": [],
  "checks": [
    {
      "id": "no-committed-secret",
      "claimId": "no-committed-secret",
      "level": "L3",
      "state": "held",
      "authoredBy": "construct",
      "mechanism": ".github/workflows/security.yml runs gitleaks over the history on every push and pull request"
    },
    {
      "id": "vulnerable-dependencies-are-visible",
      "claimId": "vulnerable-dependencies-are-visible",
      "level": "L3",
      "state": "held",
      "authoredBy": "construct",
      "mechanism": "security.yml runs pnpm audit weekly and on pull requests, reporting only"
    },
    {
      "id": "ci",
      "claimId": "every-change-passes-the-harness",
      "level": "L3",
      "state": "unsupported",
      "authoredBy": "construct",
      "mechanism": ".github/workflows/ci.yml runs pnpm run quality on every pull request and push to main",
      "doesNotHold": [".github/workflows/ci.yml"]
    },
    {
      "id": "harness-steps",
      "claimId": "harness-steps",
      "level": "L3",
      "state": "unsupported",
      "authoredBy": "construct",
      "mechanism": ".github/workflows/ci.yml runs pnpm run quality on every pull request, and package.json spells that command out as pnpm lint, pnpm typecheck and pnpm test",
      "doesNotHold": [".github/workflows/ci.yml"]
    },
    {
      "id": "lint-policy",
      "claimId": "lint-policy",
      "level": "L3",
      "state": "unsupported",
      "authoredBy": "construct",
      "mechanism": "scripts/tests/lint/syntax-policy.test.ts asserts the restrictions the lint policy declares, and .github/workflows/ci.yml runs pnpm run quality over it on every pull request",
      "doesNotHold": [".github/workflows/ci.yml"]
    }
  ],
  "hypotheses": [
    {
      "hypothesisId": "one-deployable-under-apps",
      "statement": "The single deployable is apps/api",
      "baseSha": "9f1c2a0e4b7d8c6a5f3e2d1c0b9a8f7e6d5c4b3a",
      "evidenceClean": false,
      "state": "unsupported",
      "doesNotHold": ["apps/api/package.json"]
    },
    {
      "hypothesisId": "deployed-as-a-single-container",
      "statement": "This repository is deployed as a single container",
      "baseSha": null,
      "evidenceClean": true,
      "state": "unknown",
      "reason": "no-fact-named"
    }
  ],
  "youAreHere": { "at": "stop", "stop": { "claimId": "every-change-passes-the-harness", "stage": "enforcement", "state": "unsupported", "doesNotHold": [".github/workflows/ci.yml"] } },
  "notCarried": [{ "claimId": "lint-policy", "reading": "does-not-hold", "path": "scripts/tests/lint/syntax-policy.test.ts" }],
  "versionGap": { "materializedBy": "0.1.0", "readBy": "0.2.0", "pending": 3 }
}
```

`schemaVersion` is the version of this key set, not of the CLI; it rises when a key is removed or
renamed. With no `construct.json` in the directory, `--json` prints
`{ "schemaVersion": 1, "state": "no-manifest" }` and exits `1`, as before. Earlier builds printed
`null` there: a reader that tested for `null` now tests for `state` being `"no-manifest"`.

`ok`, `missingFiles`, `modifiedFiles`, `missingDiscovery`, `provenance`, `warnings` and
`versionGap` keep their names, types and meaning. `harnessProblems` keeps its name and its type and
narrows to provenance: the step-coverage entries — `"quality" does not run lint`, `typecheck`,
`test`, `contracts:check` — are gone from it and are read off the `harness-steps` claim instead,
which leaves `ok` unchanged for every repository. `provenance` has one entry per
marker, in the order the markers are declared, each with `marker`, `file` and `authorship`
(`construct`, `owner` or `unknown`).

This version changes the knowledge half of the contract:

- `uncollectedTests: string[]` is new, and carries what the `construct-tests` verdict used to say.
- `checks` entries gain `claimId` and `authoredBy`; `state` is now `held`, `unsupported` or
  `unknown` rather than `present`, `absent` or `unknown`.
- `evidence` is renamed `mechanism`, because it is what the claim expects rather than a reading of
  the repository, and each entry now carries what its state knows: `doesNotHold` under
  `unsupported`, `reason` (with `unevaluable` where a fact could not be read) under `unknown`.
- `hook` and `red-gate` are gone from `checks`, and `construct-tests` with them. `checks` now carries
  one entry per claim in the model, in the model's declaration order — an empty list where the
  repository has no `construct.model.json`. `id` is the claim id, except for the two legacy names
  the model still carries as `checkId`: `ci` and `lint-policy`.
- `weakestLink` is replaced by `youAreHere: {at, stop?}`, where `at` is one of `stop`, `no-stop`,
  `no-claim` and `no-model`, and `stop` is carried only under `at: "stop"`. That stop carries the
  same facts the verdict for that claim carries, from the same derivation: `doesNotHold` where it
  stops `unsupported`, `reason` where `unknown`. It is never `null`: no model, a model naming no
  claim and a model whose chains all hold are three readings and not one.

## construct sync

Replays today's templates for the preset `construct.json` recorded, with the variables it recorded,
and classifies every path the construct owns against the tree as it is now. Without `--apply` it
prints the classification and writes nothing — not a file, not the manifest it read, so a person can
look at what would happen before anything happens. With `--apply` it writes the paths the construct
can prove it owns, and nothing else.

| Option | Default | What it does |
|---|---|---|
| `--json` | `false` | The classification as a JSON object, for CI. |
| `--apply` | `false` | Write the paths the construct owns. The only way `sync` writes anything. |

```bash
npx mikoshi-construct sync
```

```
Sync report

Classes
  add       1
  keep      24
  update    2
  conflict  9
  removed   0
  orphaned  0
  foreign   0

add
  tsconfig.base.json

update
  AGENTS.md — the construct block is replaced whole — edits between the delimiters do not survive; …
  CLAUDE.md — the construct block is replaced whole — edits between the delimiters do not survive; …

conflict
  eslint.config.mjs
  package.json — keys: version (conflict), private (add), scripts.quality (conflict)
  vitest.config.ts

A merged target is reported by its keys and never rewritten: no merge-json file is written in this version.

3 paths can be written: run `construct sync --apply`.
Materialized by construct 0.1.0, read by 0.2.0.
```

### The eight classes

| Class | Meaning | Listed |
|---|---|---|
| `add` | Today's templates produce it; neither the record nor the tree carries it. | yes |
| `keep` | What the templates produce is what the tree already carries. | counted only |
| `update` | The construct's own view of the file changed, and the tree still matches what was recorded. | yes |
| `conflict` | The file diverged from what was recorded, or it was never recorded and is not the construct's to claim. | yes |
| `unknown` | An `append-block` target whose template variant cannot be established: no recorded variant, and no rendering that hashes to what was recorded. | yes |
| `removed` | The record carries it and the tree does not. | yes |
| `orphaned` | The record carries it and today's templates no longer produce it. | yes |
| `moved` | The record carries it, its bytes are what was recorded, and today's templates write it under a new path (`scripts/construct/implement.workflow.mjs` → `scripts/construct/implement.workflow`). `--apply` removes it and writes the new path. If its bytes changed, it and the new path are both `conflict` and nothing is written, so the two never lie side by side. | yes |
| `foreign` | The tree carries it, no record and no template does. Not the construct's to discuss. | counted only |

`keep` is the quiet majority and `foreign` is not ours to discuss, so both are counted and neither is
listed. A `merge-json` target — `package.json` — is reported by the keys that differ, and merged
files are not written in this version at all, which is why `package.json` never appears among the
writable paths.

`unknown` is the reading of a block whose provenance the record cannot settle. `AGENTS.md` and
`CLAUDE.md` ship in two variants — the one `init` writes when it creates the file and the one it
writes into a repository that already had the file — and splicing the wrong variant into a file would
replace a block with text that was never there. When neither the recorded variant nor a rendering
matching the recorded hash establishes which one wrote it, sync says so and writes the path in no
mode: not with `--apply`, not without it. The report names the shape the file reads like, and says in
the same line that a shape is a guess and never enough to write on.

An `append-block` target that would be written carries its write effect on the classification itself:
the block between `construct:begin` and `construct:end` is replaced whole, so edits made between the
delimiters do not survive, while the `construct:discover` marker bodies are carried over. The report
prints that effect from the classification rather than restating it, so there is one statement of the
fact and nothing to drift.

The last line names the version that materialized the repository against the version reading it. That
is the question an owner actually has.

### Writing with `--apply`

```bash
npx mikoshi-construct sync --apply
```

```
Sync apply
Materialized by construct 0.1.0, read by 0.2.0.

Written
  AGENTS.md — the construct block is replaced whole — edits between the delimiters do not survive; …
  CLAUDE.md — the construct block is replaced whole — edits between the delimiters do not survive; …
  tsconfig.base.json

Left to you
  package.json — keys: scripts.quality (conflict), private (add)
A merged target is reported by its keys and never rewritten: no merge-json file is written in this version.

3 paths written. The manifest records the owned view of each of them.
1 path the record cannot prove the construct owns. Yours to carry across.
```

**What it writes.** Every path classified `add` or `update` whose strategy is `create` or
`append-block`. A `create` target is written as the templates produce it. An `append-block` target
that is absent is written whole; one that is already in the tree is spliced — the produced text
between the markers replaces the text between the markers the file carries, every byte outside them
is kept, and a filled `construct:discover` body is carried over into the new block. Each written path
has the sha of its owned view recorded under `sync` in `construct.json`, together with when the run
happened, the version that materialized the repository and the version that wrote. The branch `init`
wrote is never touched, and when nothing was written `construct.json` is not touched at all.

**What it never writes.** A `keep` (there is nothing to write), a `conflict` (a decision only an owner
can make), a `removed` path (deleted deliberately; sync never puts it back), an `orphaned` path (it
has passed to you) and a `foreign` one (never ours). Conflicts are reported and never resolved. No
`merge-json` target is written in this version at all — including a `package.json` whose owned keys
read as `update`, because the record cannot say which keys were the construct's. And no file is ever
deleted. There is no flag that overrides any of this.

**`doctor` still calls a rewritten file modified.** The baseline `doctor` checks is what `init`
recorded and decision 0006 froze; a block sync rewrote no longer hashes to it. Sync records what it
wrote in its own branch instead of correcting the baseline, because correcting it would erase the
evidence of what `init` actually did.

### construct mutate

Carries one named wrong implementation from a brief
([decision 0029](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0029-an-acceptance-is-red-under-a-named-wrong-implementation.md))
from edit to verdict. The CLI owns the edit, its record, the restoration and the judgment; running
the tests stays with you or the agent
([decision 0031](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0031-the-cli-owns-the-mutation-the-runner-owns-execution.md)).
`mutate` starts no process: the two halves meet only through files.

```bash
npx vitest run --reporter=json --outputFile=green.json
construct mutate judge --baseline --report green.json
construct mutate apply --from brief.md --id M2
npx vitest run --reporter=json --outputFile=m2.json
construct mutate judge --id M2 --report m2.json
```

| Subcommand | Options | What it does |
|---|---|---|
| `mutate judge --baseline` | `--report <file>`, `--format <vitest-json\|junit-xml>`, `--json` | Records a well-formed report in which nothing failed as `.construct/mutations/baseline.json`, with the report's run start time. A red, empty or unreadable report is refused and nothing is written. |
| `mutate apply` | `--from <file>`, `--id <id>`, `--json` | Applies the line with that id: one `find` → `replace` in one file, after copying the original to `.construct/mutations/<id>.orig` and recording `<id>.json` (the file's sha256 before and after, `appliedAt`, the prediction). |
| `mutate judge` | `--id <id>`, `--report <file>`, `--format <vitest-json\|junit-xml>`, `--json` | Restores the file from the copy, compares it byte for byte, deletes the record and the copy, then reads the outcome from the report. |

`--format` names how `--report` is written, and defaults to `vitest-json`: Vitest's own `--reporter=json
--outputFile=<file>`, whose run start time is its top-level `startTime`. `--format junit-xml` reads a
JUnit XML report from any runner; its run start time is the earliest `timestamp` attribute across its
`<testsuite>` elements, parsed as a date. A JUnit report with no such timestamp is refused, naming the
missing run start time — never the report file's own modification time, which says when the file was
written, not when the run started.

A mutation line starts with `M`; every other line of `--from` is ignored. Backtick-delimited strings
are taken literally.

```
M2 | src/x.ts | find: `a < b` → `a <= b` | red: tests/x.test.ts › describe › title | `expected 1 to be 2`
```

The `red:` field names a test by its file, relative to `--dir`, then its describe blocks and its
title, separated by ` › `; or it is `green`, a prediction that nothing turns red. A line whose third
field is `edit: <prose>` is a brief written before the code existed.

### What apply refuses

`apply` changes nothing and exits `1` when no green baseline is recorded, when the file was modified
after the baseline run started, when `.construct/mutations/` still holds a record or copy for that id,
when `--from` has no line or several lines with that id, when the line is malformed or an `edit:`
line, when the file is missing or outside `--dir`, and when `find` does not occur exactly once. After
a successful `judge` the file's modification time is set back to the original's, so the next
mutation of the same file does not need a new baseline.

### What judge decides, in order

1. The file is not what `apply` wrote (its sha256 differs from the recorded one): a **hard failure**.
   The file is someone else's edit and is not touched; the record and the copy stay, and the output
   names the copy.
2. The report is unreadable or malformed, or it started before the mutation was applied: the file is
   restored and the result is **no witness**.
3. The restoration or the byte comparison fails: a **hard failure**, not an outcome of the mutation.
   The record and the copy stay.
4. Otherwise the file is restored and the outcome read: the named test turned red, another test
   turned red (each one named by file and full name), or nothing turned red — the criterion does not
   tell the implementation apart. With a `green` prediction, nothing turning red is the prediction.

The named test is matched exactly, by its file and by its describe blocks and title. A report in
which more than one test carries that name, or none does, is refused rather than read from its first
match. The restoration always comes from the copy, never from reversing the replacement and never
from git. After a hard failure the record stays, so a second `apply` with that id refuses until the
file is restored by hand.

The verdict rests on the report you hand over. The CLI checks that it is well formed and newer than
the mutation; it cannot check which tree it ran on, and the output says so.

| Result | Exit |
|---|---|
| The outcome matches the prediction; `--baseline` recorded | `0` |
| Refused | `1` |
| The outcome does not match the prediction; no witness | `2` |
| Hard failure | `3` |

`--json` prints one object with `schemaVersion` and `state` (`matched`, `baselineRecorded`,
`refused`, `unmatched`, `noWitness` or `hardFailure`). The records under `.construct/mutations/` are
local working state, not part of the recorded surface.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Reporting: nothing to write, `add` and `update` are both empty. With `--apply`: every path classified `add` or `update` was written. |
| `1` | No `construct.json` here, or a write failed. |
| `2` | Reporting: `add` or `update` has entries — there is something a writer could do. With `--apply`: a pending path was refused because it is a `merge-json` target. |

Conflicts, removals, orphans and unestablished variants never change the code by themselves. They are
information, not work the tool can carry out: a conflict is reported and never resolved, because it
is a decision only an owner can make; a removed or an orphaned path is a fact about the tree; and an
`unknown` variant is a question the record cannot answer. Nothing is ever deleted, and nothing
classified `removed` is ever recreated.

**A `2` after a release is work becoming available, not a fault.** The moment a release adds a
template file, every repository that does not carry it yet classifies it `add`, and `sync` exits `2`
for its owner. That is the command doing its job. It follows that `sync` does not belong in a quality
gate: wiring it into `pnpm run quality` or a CI job that must stay green turns our next release into
a red build in your repository, for a change you have not read yet. Run it when you want to know, and
`--apply` when you want it written.

`--json` prints one object with `schemaVersion` (the version of this key set, not of the CLI),
`fromVersion`, `toVersion`, `counts` (one entry per class) and
`paths` — every classified path with its `class`, its `strategy`, its `keys` for a `merge-json`
target and its `writeEffect` where the classification carries one. A machine reader never parses the
prose. With `--apply` the same object carries four more fields:
`written` (the targets that were written, in write order), `retired` (the `moved` targets it removed
because their new path was written), `pending` (the targets classified `add` or
`update` that were refused) and `ranAt` (the ISO timestamp recorded in the manifest). With no
`construct.json`, both forms print `{ "schemaVersion": 1, "state": "no-manifest" }` and exit `1`;
earlier builds printed `null`, so a reader that tested for `null` now tests for `state` being
`"no-manifest"`.

```json
{
  "schemaVersion": 1,
  "fromVersion": "0.1.0",
  "toVersion": "0.2.0",
  "counts": { "add": 1, "keep": 41, "update": 2, "conflict": 5, "removed": 0, "orphaned": 1, "foreign": 0 },
  "paths": [
    { "target": "AGENTS.md", "class": "update", "strategy": "append-block", "writeEffect": "block-replaced-whole-discovery-bodies-carried-over" },
    { "target": "package.json", "class": "update", "strategy": "merge-json", "keys": [{ "key": "scripts.sync", "class": "add" }] },
    { "target": "eslint.config.mjs", "class": "conflict", "strategy": "create" }
  ]
}
```

### After a write

The full sequence a repository runs when a release lands — report, `--apply`, your own harness,
`doctor` — and what the report leaves for you to decide, is on its own page:
[Upgrading a repository](/guide/upgrading).

## construct attach

Brings the reasoning-budget discipline — the `/plan` command, the `/implement` skill, the three
agents and the ladder script — into a repository the construct did not write, without touching a
tracked file. It writes nine carriers, a commit guard and the shell parser the guard reads the command
line through, hides them and the ledger directory through
`.git/info/exclude`, adds one entry to the untracked `.claude/settings.local.json`, and records what it
did in `.construct/attach.json`. No `construct.json`, no
`construct.model.json`, no discovery markers, no harness, lint or CI files. Alias: `jack-in`.

| Option | Default | What it does |
|---|---|---|
| `--harness <command>` | asked | The command the ladder verifies every change with. Nothing is assumed: without a terminal it must be passed. |
| `--ai <target>` | `claude` | Only `claude` is supported; `cursor` and `both` are refused, because a Cursor rule with `alwaysApply` would govern the whole tree. |
| `--yes`, `-y` | `false` | Skip the confirmation. Needs `--harness`. |
| `--entry` | `false` | Print the entry protocol and exit `0`; nothing else runs, whatever other flags are given. |

```bash
npx mikoshi-construct attach --harness "npm test"
```

### The entry protocol

`npx mikoshi-construct attach --entry` prints the banner and then `templates/attach/entry.md`, the
protocol by which an agent reads a repository and proposes one harness command. It reads no repository,
writes nothing and exits `0`, so it runs in a directory that is not a repository too, and it runs alone
when `--yes` and `--harness` are given beside it. The protocol is the file, and this page only names its
parts:

1. Where the tree stands: `git status --porcelain`, the branch and its upstream, ahead and behind as
   last fetched, and the age of that reading from `.git/FETCH_HEAD`. A fetch is run only when the owner
   says yes.
2. What an earlier construct left, and how to read the two collision labels below.
3. What CI runs, every definition read whole, and what the repository can run: `package.json` scripts,
   `Makefile`, `pyproject.toml`, hooks and READMEs.
4. The test surface as one table headed `Suite | Runner | Where | Run by CI`, whose last column is the
   job and step or `not run by CI`, and the same suites again in a list headed `Not run by CI:`. A suite
   CI does not run is never added to the proposal.
5. One proposal, exactly one command in one form, mirroring the CI jobs in order and never run to find
   out, and one question the owner answers yes or no. Yes runs
   `npx mikoshi-construct attach --yes --harness "<command>"`; no means attach is not run.

attach reads none of this itself: which command mirrors a repository's CI is a reading of the
repository, and that is the agent's ([decision 0034](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0034-stack-detection-is-not-an-attach-gate.md),
[decision 0037](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0037-attach-entry-is-read-by-the-agent.md)).

### The twelve refusals

Every check runs before anything is written, in this order, and a refusal creates nothing — not even
`.construct/`:

| Refusal | Plain output |
|---|---|
| `<dir>/.git` does not exist | `Refused: not a git repository.` |
| `<dir>/.git` is a file (a worktree or a submodule) | `Refused: .git is a file (worktree or submodule); attach needs the .git directory.` |
| `construct.json` exists | `Refused: this repository already carries a construct; use init or sync.` |
| `.construct/attach.json` exists | `Refused: this repository is already attached (.construct/attach.json is here); run \`construct detach\` first.` |
| the directory holds nothing but `.git` and the files an empty directory may hold (`README.md`, `LICENSE`, editor settings) | `Refused: this repository holds nothing to attach to.` |
| a path attach would create already exists | `Refused: N paths attach would create already exist:`, then why and the next step, then the paths, each labelled `construct's own: byte for byte the template of <date>` or `not recognised: attach never writes over it` (see [A collision](#a-collision)) |
| `.claude/settings.local.json` exists and `.git/index` cannot be read (version 4, split, sparse or an unknown object format) | `Refused: .claude/settings.local.json exists and .git/index cannot be read here, so whether git tracks it cannot be told.`, then why and next |
| `.claude/settings.local.json` is tracked by git | `Refused: .claude/settings.local.json is tracked by git.`, then why and next |
| `.claude/settings.local.json` does not parse as a JSON object, its `hooks` is not an object, its `hooks.PreToolUse` is not a list, or it is not a regular file (a symlink) | `Refused: .claude/settings.local.json is not a settings file attach can edit.`, then why and next |
| `.claude/settings.local.json` already carries an entry that runs `.construct/commit-guard.mjs` | `Refused: .claude/settings.local.json already carries an entry that runs .construct/commit-guard.mjs.`, then why, and next: keep the file; run `construct detach` first if the repository is still attached, or delete only that entry |
| `--yes` without `--harness` | `Refused: --yes needs --harness <command>; nothing is assumed.`, then why, and the next step: `npx mikoshi-construct attach --entry` prints the entry protocol |
| `--ai cursor` or `--ai both` | `Refused: --ai cursor is not supported by attach yet; its rules would apply to the whole tree.` |
| the first word of the harness command (after any `VAR=value`) is not a path, a shell word such as `cd`, or an executable in an absolute `PATH` directory — a `package.json` script name such as `quality`, or a binary under `node_modules/.bin` such as `vitest` | `Refused: "quality" is not a command found on PATH.`, then why, and the next step with the rest of the command kept: `--harness "npm run quality"  or  --harness "npx quality"` |

The three settings refusals run only when `.claude/settings.local.json` exists, after the collision
check and before the harness is asked for. The harness is checked after it is named, so its refusal
comes after the others, and it too creates nothing. `PATH` is read as a list of directories and nothing is run; a relative entry (`.` or
an empty one) is not counted, because the ladder runs the harness from wherever its shell stands.

A harness command that edits files — a word ending in `:fix`, `--fix` or `--write` — is not refused:
attach warns, says why a gate that fixes what it checks is a weaker gate, names the command form that
only checks, and goes on. It reads the command as written and does not open `package.json`, so
`pnpm run quality` whose script runs `lint:fix` is not caught.

### A collision

attach writes over nothing, not even a file it wrote itself in an earlier run. Each colliding carrier
path is hashed (sha256 of its bytes) and compared with `templates/attach/earlier-carriers.json`, the
known set: every template any carrier ever had in this repository's history, written by
`scripts/attach/earlier-carriers.ts` and never by hand. A path labelled
`construct's own: byte for byte the template of <date>` holds exactly such a template, at that carrier's
own path. Anything else is labelled `not recognised: attach never writes over it`: an owner's file, a
template with one byte changed, a template at another carrier's path, a symlink, a directory.

The next step is the one command that clears the way. When some paths are construct's own it is
`cd <dir> && rm -- <those paths> && npx mikoshi-construct attach --dir <dir>`, with `--yes` and
`--harness` carried over when they were given. A path labelled not recognised is never on the delete
command, and when none is recognised there is no delete command at all: attach says to move them
yourself, then run it again. A collision found during the write keeps the output and rollback below.

### The write order

1. The exclude block: `.git/info/exclude` gains a `# construct:begin` … `# construct:end` block
   listing `.construct/`, every path attach writes and `.claude/settings.local.json`, one per line.
   When the file does not exist, it is created with only that block and the record says so.
2. The nine carriers: `.claude/commands/plan.md`, `.claude/skills/implement/SKILL.md`,
   `.claude/agents/architect.md`, `.claude/agents/harness.md`, `.claude/agents/implementer.md`,
   `scripts/construct/implement.workflow`, `scripts/construct/check-acceptance.mjs`,
   `scripts/construct/browser-witness.mjs`, `scripts/construct/check-baseline.mjs`, byte-identical to what `init` writes, and then the commit guard `.construct/commit-guard.mjs` and the shell parser it imports, `.construct/shell-parser.mjs`.
3. The guard entry in `.claude/settings.local.json` (below). The file is read again at this moment: if
   it no longer parses, or already carries a guard entry, the files of this run are rolled back and
   attach refuses.
4. The record, `.construct/attach.json`.

The carriers and the guard are written exclusively (`wx`), in the order listed above. If one of them appears between
the collision check and the write, attach does not write over it: it removes the files this run wrote
(only those whose bytes are still what it wrote), the directories it created that are now empty, and
its block from `.git/info/exclude` together with exactly the separator it added, so the file is byte
for byte what it was (deleted only when nothing else is left in it), then refuses with `COLLISION`
naming that path. Nothing of this run is left behind, with one exception it says out loud: if the
bytes before its block changed in that window, the block stays rather than a byte of yours going,
and `construct detach` names it.

### The commit guard

`.construct/commit-guard.mjs` is a Claude Code `PreToolUse` hook for the `Bash` tool. attach registers
it by appending one element to `hooks.PreToolUse` in `.claude/settings.local.json`: the entry
`{"matcher":"Bash","hooks":[{"type":"command","command":"node \"$CLAUDE_PROJECT_DIR\"/.construct/commit-guard.mjs","timeout":30}]}`.
It creates the file, `hooks` or `PreToolUse` only where each is missing, appends after any existing
element and changes nothing else in the object; the file is written to a temporary file and renamed over
the original, so the formatting of the rest of it may change. A session started after attach reads the
entry; nothing here claims that a session already running does. The guard imports its reader of the
command line, `.construct/shell-parser.mjs`, when a call arrives; attach writes and detach removes both
files, and a call arriving while the parser is missing is refused with exit 2.

The guard refuses the agent a `git commit`, `git push`, `git merge`, `git rebase` or `git tag` into the
attached repository, or into a repository it cannot pin down, with exit code 2 and three lines, what,
why and next. There is no bypass: it reads no environment variable and writes no audit file, and the
owner's own terminal never passes through it. It follows `git -C`, `git -c`, `--git-dir`, a leading
`cd`, a subshell, an assignment (a `GIT_DIR=` prefix included), the wrappers `env` (an `-S` string read as
the words it splits into), `nice`, `sudo`, `timeout` and `xargs` under any path, and the worktrees of the attached repository, and takes the directory from
the input's `cwd`. It reads words after quotes, escapes, `$'…'` and `$"…"`, as the shell does, so `g\it commit`,
`git 'com'mit` and `git $'\x63ommit'` are refused like `git commit`. Behind `xargs` no form passes as
allowed, since what it appends breaks the exact match, and `-I` leaves the target unpinned; a
subcommand that `xargs` supplies from its input passes.

| Passes even in the attached repository | Refused, the neighbours of the forms that pass |
|---|---|
| a bare `git tag`, `git tag -l` and `git tag --list`, each with patterns that do not start with a dash | `git tag v1`, `git tag -d v1`, `git tag -l x -d y`, `git tag -list-something` |
| `git merge --abort` | `git merge --continue` |
| `git rebase --abort` | `git rebase --continue`, `git rebase -i` |

A guarded command whose target the guard cannot pin down — a path held in a variable, `cd -`, an
unquoted variable, a `--git-dir` that does not resolve, or a directory that does not exist yet — is
refused with a line that says it cannot pin down the repository and names the way out, which is to write
it as `git -C <path> <subcommand> …`. An unguarded command on such a target passes, and so does `git tag -l`.

Everything else passes with exit `0` and nothing on stderr: a commit, merge or tag into another
repository, the words inside a quoted string, a comment, `git status`, `git log`, `git cherry-pick`,
`git revert`, `git am`, `git stash`, `git commit-tree`, a read in a worktree and a call to another tool.
It is a guard against the direct form, not a sandbox: a commit inside a script, an alias, `bash -c` or
`eval` passes. It reads stdin to its end however late it arrives; a read that fails or ends empty is
refused with exit `2`, and so is everything that is not an explicit allow: input that is not a JSON object, or an
error while checking the call, refuses with exit `2` and one line on stderr, since Claude Code runs the call on any
other non-zero exit. It needs `node` and `git` on the host. Three outcomes stay open, because the hook cannot reach
them: without `node`, or when the file cannot be loaded at all, the hook errors visibly and does not block; and a
run longer than its 30 s `timeout` is killed by Claude Code, which then runs the call.

attach refuses instead of editing `.claude/settings.local.json` when it is tracked, unreadable or
already carries a guard entry (the three settings refusals above). [`construct detach`](#construct-detach)
takes the entry out again.

### The record

`.construct/attach.json` is a public format: the carried commands read `harness.command` from it
when there is no `construct.json`, and [`construct detach`](#construct-detach) removes exactly what it
lists.

| Field | What it holds |
|---|---|
| `recordVersion` | `2`. The shape of this record, separate from the CLI version. A `1` written by an earlier build detaches as before and no settings entry is sought. |
| `construct` | The CLI version that attached. |
| `attachedAt` | ISO timestamp of the run. |
| `harness.command` | The command passed or answered. Never a default. |
| `files` | Every carrier path, `.construct/commit-guard.mjs` and `.construct/shell-parser.mjs` with the sha256 of the bytes written. The record itself is not in it. |
| `directories` | The directories that did not exist before and were created, parents first. `.construct/` is not in it. |
| `excludeCreated` | Whether `.git/info/exclude` was created by this run or already existed. |
| `ledgerCreated` | Whether `.construct/` was created by this run (`true`) or already existed (`false`). `detach` removes `.construct/` only when this is `true`; a record without the field (written before it existed) does not say, so `.construct/` stays. |
| `settingsHook` | `file` (`.claude/settings.local.json`), `created` (`file`, `hooks` and `preToolUse`: whether this run created each), and `entry`, the element appended to `hooks.PreToolUse` as written. `detach` compares the entry by value and removes the file, `hooks` or `PreToolUse` only where `created` says attach made it and it is now empty. |
| `excludeSeparator` | How many newlines (`0`, `1` or `2`) attach put before its block in `.git/info/exclude`. `detach` removes the block together with exactly that many, which is what makes the file byte for byte what it was; any other value is refused. |

The report ends with a trailer to copy into commits, `Attached-Construct: mikoshi-construct@<version>`,
one sentence for a pull request, and the next steps: `claude → /plan <feature>`, later
`construct detach`.

Exits `0` when it writes, `1` on any refusal, on a cancelled prompt, or when there is no terminal and
no `--yes`.

## construct detach

The inverse of `attach`: removes what `.construct/attach.json` lists, the commit guard entry it added to
`.claude/settings.local.json` included, and nothing else. It reads
everything before it writes anything, so a refusal leaves the tree exactly as it found it. Alias:
`jack-out`. There is no `--force`.

```bash
npx mikoshi-construct detach
```

### The three states

| State | What detach does | Exit |
|---|---|---|
| no record and no construct block in `.git/info/exclude` | prints `Nothing is attached here.` and writes nothing | `0` |
| a construct block in `.git/info/exclude` and no record | refuses: what the block hides cannot be told from yours. Each path in the block is printed marked `on disk` or `not on disk`. Nothing is written | `1` |
| a record | proceeds; a record without a block makes the block removal a no-op | see below |

### The four file classes

With a record, detach reads the tracked set from `.git/index` and classifies every recorded file, in
this order, taking the first class that matches:

| Class | Test | What happens |
|---|---|---|
| adopted | the path is in the git index (you committed it with `git add -f`) | named, not removed, not counted; its directory stays |
| already absent | the path is not on disk | named, not removed, not counted |
| changed | the bytes on disk hash differently from the record | the whole run refuses, listing the changed paths; nothing is removed |
| to remove | the bytes are what attach wrote | removed |

The commit guard entry in `.claude/settings.local.json` is classed after the files, in this order:

| Class | Test | What happens |
|---|---|---|
| adopted | `.claude/settings.local.json` is in the git index | named, left byte for byte |
| already absent | the file is missing, or no element of `hooks.PreToolUse` runs `.construct/commit-guard.mjs` | named as `already absent: .claude/settings.local.json commit guard entry`; the guard script is still removed |
| unreadable | the file no longer parses as a settings file | refused as `settings-unreadable`, nothing removed |
| changed | an element runs the guard and differs from the recorded entry | the path joins the `changed` refusal, nothing removed |
| to remove | every such element is the recorded entry | the entry is taken out first; a file attach created is deleted when nothing else is left in it, and counts as removed; an entry cut out of a file that stays is reported on its own line and not counted |

Whatever else the file holds, grants or other hooks, is never read for the decision and never removed.
A version 2 record whose `settingsHook` is missing, or names another path, is refused as `hook-record`,
removing nothing.

If nothing is changed, detach removes the files to remove, then the recorded directories that are now
empty (deepest first), then the block it added to `.git/info/exclude` (the file itself only when
nothing else is left in it), then `.construct/attach.json`, and `.construct/` when it is empty and the record's `ledgerCreated` is `true`. A file
inside a recorded directory that the record does not list — `.construct/runs.jsonl`, a settings file
that stays because it holds more than the entry — is never deleted; its directory stays and it is named as left behind.
Once the exclude block is gone such a file is an ordinary untracked path, so `git status` shows it.

### The four index refusals

The tracked set is read from `.git/index` directly; the CLI runs no `git`. Index versions 2 and 3 are
read, with `sha1` and `sha256` object formats. Four shapes are refused, each with its own reason,
before anything is removed:

| Index | Plain output |
|---|---|
| version 4 (`index.version 4` or `feature.manyFiles`) | `Refused: .git/index is version 4 (prefix-compressed names), which detach cannot read; nothing was removed.` |
| split index (`link` extension, `core.splitIndex`) | `Refused: .git/index is a split index (link extension), which detach cannot read; nothing was removed.` |
| sparse index (`sdir` extension, `index.sparse`) | `Refused: .git/index is a sparse index (sdir extension), which detach cannot read; nothing was removed.` |
| `extensions.objectFormat` neither `sha1` nor `sha256` | `Refused: extensions.objectFormat in .git/config is neither sha1 nor sha256, so .git/index cannot be read; nothing was removed.` |

Two refusals are about the record itself, and both come before anything else is read. A
`recordVersion` that is missing or not a positive integer means which build wrote the record cannot be
told, so detach refuses and names the value it found. A `recordVersion` higher than this binary
understands is refused the way a later `construct.json` is: the line names both versions and says to
upgrade the CLI. That is what a CLI from before the commit guard says of a `recordVersion` 2 record
this build wrote: upgrade the CLI (`npx mikoshi-construct@latest`) before running `detach` on a
repository this release attached. Nothing is removed in either case.

Two more refusals are about the exclude block rather than the index. An `excludeSeparator` that is
missing or not `0`, `1` or `2` means the block cannot be cut out to the byte, so detach refuses, names
the value it found and removes nothing. And when the bytes right before the block are no longer that
many newlines (a blank line you deleted by hand, say), cutting the block out would take a byte of
yours, so detach refuses and removes nothing; the block is checked before the first removal.

`git update-index --index-version 2` and `git update-index --no-split-index` return an index detach
can read; a sparse index expands with `git sparse-checkout disable` or `git config index.sparse false`
followed by any command that rewrites the index.

### The report

One `- path` line per removed path, files then directories; then every adopted, already-absent and
left-behind path with its label; then one line naming what is not counted — the record, `.construct/`
once empty if attach created it, and the exclude block; then `Detached. Removed N paths.` where N is the number of files
and directories actually removed. On the nine carriers, the guard and its parser into a repository with none of
their directories, N is 19: eleven files, seven directories and the settings file attach created.

Exits `0` when it removed what it could or when nothing is attached, `1` on any refusal.

## construct soulkill

Prints what the detector sees and writes nothing. It is the same code `init` runs, so it is also how
you debug a preset suggestion you did not expect. Aliases: `inspect`, `capture`.

| Option | Default | What it does |
|---|---|---|
| `--json` | `false` | The detect report as JSON, with a top-level `schemaVersion`. |

```bash
npx mikoshi-construct soulkill
```

```
>> Inspecting repository...

  ├─ Directory: /srv/projects/my-service
  ├─ CLI runtime: Node.js 24 (the Node running construct, not read from this repository)
  ├─ CLI pnpm: pnpm 12.4.2 (the pnpm on the PATH construct runs with, not read from this repository)
  ├─ Package manager: pnpm
  ├─ Layout: monorepo (pnpm-workspace)
  ├─ Workspace dirs: apps, packages (7 packages)
  ├─ Other stacks' manifests: none
  ├─ src/: no
  ├─ Contracts: contracts/api/openapi.yaml
  ├─ tsconfig / ESLint config: yes / yes
  ├─ GitHub workflows: yes
  ├─ CLAUDE.md / AGENTS.md / .cursor/rules: yes / yes / yes
  └─ construct.json: no
```

These are facts, not opinions. The detector reports the package manager, the layout, the workspace
packages and which files already exist. Anything that needs judgement is left to discovery.

## construct cost

Reads the Claude Code session files for this directory and sums the tokens each `/implement` run
spent, per agent. It is the evidence behind the reasoning budget: cheap tasks should stay cheap.

| Option | Default | What it does |
|---|---|---|
| `--last` | `false` | Only the most recent run. |
| `--json` | `false` | The report as a JSON object. |

```bash
npx mikoshi-construct cost --last
```

Each agent line carries its call count and its input, cache-write, cache-read and output tokens. The
run total is printed twice: tokens without cache reads (input, cache writes and output — the unit of the
step split and the forecasts), and an input-equivalent figure that weights cache writes
at 1.25, cache reads at 0.1 and output at 5, so a cheap run and an expensive one can be compared at a
glance.

The runtime is resolved first — from the environment the command runs in, otherwise from the `ai`
target in `construct.json` — and only then asked for its usage. A runtime whose per-run usage is not
readable (Cursor, for instance, which keeps no such session files) is reported as `unsupported`,
never as an absence of runs.

Every report names the version of the CLI that produced it, before the numbers in the text register
and as `version` in `--json`. Two builds of `construct` can count the same session differently, so a
figure quoted without the version of the binary that measured it says nothing about what was counted.

`--json` prints one object: `schemaVersion` (the version of this key set, not of the CLI), `status`
(`ok`, `empty`, `unsupported`, `mismatch` or `unknown`),
`runtime` (`claude-code` or `cursor`), `version` (the CLI that produced the report), `key` and
`candidates` where the project key is in question, `runs` when there are any, and `ledger` and
`reconciliation` as described below, and `turns` in every report: the turn journal, described below.

### The run ledger

`.construct/runs.jsonl` is the ladder's own journal: one JSON line per `/implement` run, appended by
step 4 of the `implement` skill. That step is an instruction in a prompt — nothing makes it happen
and nothing notices when it does not — so the ledger is **L0** on the scale `doctor` reports: a
record nobody is obliged to keep. Read it as a claim to be checked, never as a complete history of
what ran. Decision 0003 records why it stops there.

Each line holds `contract/contours/ledger-row.schema.json`, whose `$id` is recorded in the surface under
`contours`. `construct cost`, `ghosts:launch`, `ghosts:watch` and `pnpm board` all read it through
`parseLedgerLine`, and a malformed line is refused naming the field.

Each line carries exactly these fields:

| Field | Meaning |
|---|---|
| `run` | The Workflow run identifier the runtime reported for the run. This is the join key. It is optional only because older entries exist; when present it is a non-empty string. |
| `at` | ISO timestamp of the run. |
| `task` | The task text, first 120 characters. |
| `effort` | The effort class the caller chose before the run. |
| `status` | One of the nine statuses of step 3 of the skill: `done`, `degraded`, `design incomplete`, `failed`, `blocked`, `base red`, `args unverified`, `base unverified` or `stopped`. |
| `rung` | The effort of the rung that finished. |
| `attempts` | One object per attempt: `rung`, `effort`, `outcome`, and a `reason` separating an invalid response shape from a red harness from a blocked report. |
| `cause` | Why a `stopped` or `failed` run ended without passing: `environment` or `human` for `stopped`, `environment` or `task` for `failed`. Required on `stopped`, optional on `failed`, forbidden on any other status. |
| `tokensSource` | Optional. `runtime` when the token figure came from the runtime's stored record instead of the Workflow tool's accounting. |
| `agreedSha256`, `argsSha256` | Optional, each 64 lowercase hex characters. The two hashes in the handle `check-acceptance.mjs build` printed: the agreed `/implement` text and the bytes of the args file the run read. Copied from the handle whatever the status; rows written before ledger-row 1.1 carry neither. |
| `agents`, `tokens`, `toolUses`, `seconds` | The Workflow tool's accounting for the whole run. `tokens` may be the string `unknown`; it is never rewritten as `0`. |

The Workflow tool reports accounting per run, not per agent, so the ledger declares no per-agent
field. It carries counts and reasons only — never a prompt or a response, which keeps the invariant
that cost reads token counts and never message content.

A line that does not parse, or that is missing a declared field, is reported as malformed with its
line number rather than skipped: a ledger that quietly drops what it cannot read is worse than no
ledger.

### Steps of a run

`construct cost` also splits every run the ledger names into its steps, one per agent of the run in
start order: the step (`preflight`, `design`, `implement` or `verify`, from the agent's workflow
phase), its role (the agent type), the attempt (the second `implement` of a run is attempt 2), the
effort its label names after `@`, its tokens (input, cache-write and output, each request counted once
by `requestId`; cache reads are left out) and its seconds (first record to last). The step comes from
the workflow phase alone: an agent with no phase, or with a phase that is none of the four, is unread
(its run, its label and the reason), and its run is not split at all. A run whose directory is not
exactly one under the Claude Code projects is not split either. Claude Code clears
old session files, so the split of each run is appended to `.construct/steps.jsonl` the first time it
is read, and every later read takes that line instead of the transcript; a line is never rewritten.
The cache holds those counts and nothing of a prompt or a response. The text and `--json` reports do
not print it; `ghosts:expect-sample --effort` reads it for its forecast by step.

The text report ends with one signal block (decision 0046) per class of finished cheap task, a class
being its card's kind and size, read from the shift journals under `~/.construct/shift` and from the
window journal `~/.construct/handoff/ghosts.jsonl`. A window task counts once `task:close` has written
its closing line with a pull request or a report and a verification word; that line records when it
ended and each session it used with the project key its session file lies under, and the session is
read under that key. A session recorded under two tasks counts for neither, and `ACTION` names each
task left out and why. `EXPECT` is the median tokens (input, cache writes and output; cache reads left
out) and minutes of the tasks of that class whose every session file is still under the Claude Code
projects, at five such tasks or more; below five it reads `none` with the count. With no finished
cheap task recorded, one block says so. `--json` does not carry it.

### Reconciliation

Where the runtime exposes session data, `cost` joins ledger entries to runtime runs on `run` and
reports the drift in both directions — never by pairing entries to sessions chronologically, which
would be a guess dressed as a finding.

Claude Code files a session under the directory it was started in, so a ladder run from a session
started in a git worktree sits under the worktree's key, not this directory's. A run the ledger names
and this directory's sessions do not hold is looked up by its `run` identifier under every other key,
and joined where it is found — including after the worktree is removed, since the session data stays.
Only runs the ledger names are taken from other keys; a session elsewhere that no entry names is never
counted here.

| Finding | Meaning |
|---|---|
| `entriesWithoutSession` | The ledger claims a run the runtime has no session for. |
| `sessionsWithoutEntry` | A run happened and was never logged — the skipped step the ledger cannot see. |
| `unjoinable` | Entries carrying no `run`, including every entry written before the key existed. They are counted, not matched. |

These are information, not failures: they never change the `status` or the exit code. On a runtime
that exposes no per-run usage there is nothing to join against, so the report shows the ledger's own
counts — runs, agents, unfinished runs — with every token figure marked `unknown` rather than `0`,
because `0` is a number and it would be a lie.

| `status` | Exit | Meaning |
|---|---|---|
| `ok` | `0` | Runs were read and printed. |
| `empty` | `0` | The runtime is readable and this directory has no recorded runs. |
| `mismatch` | `1` | No directory for the looked-up project key and no run the ledger names found under another key, but the path this directory resolves to — or the main worktree it belongs to — has one. The report names the key that was looked up. |
| `unknown` | `1` | Sibling keys look like this repository without settling it; the report says so rather than guessing. |
| `unsupported` | `3` | This runtime does not expose per-run token usage. |

### The turn journal

`.claude/hooks/turn-journal.mjs`, run by this repository's `.claude/settings.json` on `UserPromptSubmit`,
`Stop`, `SubagentStop` and `SessionEnd`, writes `.construct/turns.jsonl` in any session of the
repository, ladder or not. Unlike the run ledger it is written by a hook, not by a step in a prompt,
and it measures what each turn cost from the session transcript. Decision 0036 records why it sits
beside the ledger and does not replace it.

One JSON line per event, appended and never rewritten, each with `v` (1), `kind` and `session` (an `unread` line has no session):

| `kind` | Written when | Carries |
|---|---|---|
| `turn` | A `Stop` ends the turn a prompt opened, or a later prompt or `SessionEnd` closes it (`end`: `stop`, `superseded` or `session-end`). | `prompt`, `startedAt`, `endedAt`, `from` and `to` (byte offsets into the transcript, always at a line boundary), `usage`, `toolCalls`, `unreadable`. |
| `late` | Transcript lines land after the `Stop` that closed their turn, or a `Stop` finds no open turn. | The same range fields, attributed to the prompt of the turn it follows. |
| `subagent` | A `SubagentStop`. | `agent`, `agentType` and the range read from that agent's own transcript, from where the last stop left off. |
| `session-end` | A `SessionEnd`. | `reason`. |
| `unread` | The hook could not read its input: the read failed, or it ended empty, not JSON or not an object. It reads stdin to its end and never swallows the failure. | `at` and `reason` (an error code such as `EAGAIN`, or `empty`, `not-json`, `not-an-object`). |

It carries counts and names only: token counts, tool names, offsets, times and ids. No prompt,
response, thinking, tool input, tool result or subagent text is ever written to the journal or to the
hook's state.

A turn is the span of the transcript from a prompt to the `Stop` that ends it. A prompt that finds a
turn still open closes it as `superseded`. The ranges of a session follow each other without gap or
overlap, so a gap is a write that was lost. A transcript that shrank or whose path changed gives the
turn `usage: "unknown"` with a `reset` naming why, never a number, and the next turn is measured again.

`turns` in `--json` is `{ "status": "not recorded" }` when the file is absent, and otherwise `status`
`recorded` with `turns`, `sessions`, `main` and `subagents` (summed usage), `unmeasured` (turns whose
usage is `unknown`), `unread` (events the hook could not read), `gaps` and `malformed` (each with its line and reason). An absent journal reads
`not recorded`, never as zero: it means no hook ran here, not that nothing was spent. The figures are
never added to the runs' figures above.

### A forecast by task class

`pnpm ghosts:expect-sample [<class>] --effort <low|medium|high> [--sketch <yes|no>]` prints the `expect:` line a brief
carries, ready to paste as its line 3. The sample is the one the brief and the launcher read: the done
runs of the asked effort in the run ledgers (`--runs`, repeatable, by default `.construct/runs.jsonl`
here). It writes no file. A Ghost's ladder writes its ledger in the Ghost's own worktree, and
`pnpm ghosts:cleanup` carries those lines into the main tree's ledger before it removes the worktree,
so the main ledger is enough once a tree is gone; pass `--runs` for a worktree still running.

A row counts when `parseLedgerLine` accepts it, its `status` is `done`, its `tokens` is a number and
its `effort` matches; a run named twice counts once. A class is optional: with one, the Ghost journal
(`--journal`, by default `ghosts.jsonl` in `$CONSTRUCT_HANDOFF_DIR` or `~/.construct/handoff`) is read
too, and only rows whose `run` a journal line with `event: task` and that `class` names count.

Every figure comes from the last 20 counted rows by `at`, not the whole history. The line is
`expect: tokens ≈ <median>, minutes ≈ <median> — effort <e>, n=<n>, median, p25–p75 <p25>–<p75>` from five or
more counted rows, `expect: none — n=<n> for <selection>` from fewer, and
`expect: none — the sample for <selection> mixes efforts …; pass --effort` without `--effort` when the
rows span more than one. After it, separated by `; `, come the sources read (`ledger <path>`, and
`journal <path>` with a class) and every reason a row was left out:
`<N> rows the ledger parser rejects not counted in <ledger> (<reasons>)` and
`class not recorded on <N> lines in <journal>`. A source that is not there or a class no line carries
is the reason itself — `runs not recorded in <ledger>`, `task lines not recorded in <journal>`,
`class not recorded on <N> lines in <journal>` — never a bare `n=0`. Each counted row follows as
`<run>  tokens <n>  minutes <m>`; a journal line that is not JSON is named on stderr.

With `--effort`, a `step <step> …` line follows per ladder step, from the last 20 runs that have it, and
`--sketch yes` or `--sketch no` takes the `implement` step only from runs whose Ghost-journal `task` line
carries a sketch or `sketch: null`; runs the journal does not name are counted on neither side and named
as `<N> runs without a sketch record in <journal> not counted for implement`. A `role <brief|scan|review> …`
line per role reads the `subagent` lines of `.construct/turns.jsonl`, one run per `agent`, in the same unit
(input, cache writes and output), with `minutes not recorded`. Then
`contour tokens ≈ <sum>, p25–p75 <sum>–<sum> (sum of step bands) — covers …; not covered: <step> (<reason>)`
adds the medians and the band edges of every step and role with a sample; it is a sum of bands, not a
quantile of past contours, because a role run is not tied to a task. Any figure from fewer than five
runs is `none — <reason>`, never the overall median.

## construct board

Shows where each task stands in this repository, from what the repository holds: the ladder runs in
`.construct/runs.jsonl` and the pull request list that `gh pr list` wrote. The CLI runs no `gh` and
writes no file, `--every` included; you fetch the list and hand it over.

| Option | Default | What it does |
|---|---|---|
| `--prs <file>` | not read | The JSON written by `gh pr list`; `-` reads it from stdin. |
| `--all` | `false` | Also show what is older than 12 hours, superseded or closed. |
| `--stale <hours>` | `4` | The hours after which an open row is stale. |
| `--every <seconds>` | | Redraw every `<seconds>`, re-reading each source; refused with `--json` and with `--prs -`. |
| `--json` | `false` | The board as a JSON object. |

```bash
gh pr list --state all --limit 100 --json number,title,state,createdAt,closedAt,mergedAt,statusCheckRollup | npx mikoshi-construct board --prs -
```

The first line counts the open rows (`running`, `waiting`, `blocked`), how many of them are stale, and
the pull requests merged in the last 12 hours. The table has the columns `TASK`, `PATH`, `STAGE`, `AGE`,
`NEXT`, `EXPECT` and `ACTUAL`, ordered blocked, stale, waiting, running, the oldest first within each. A ladder run is a
row with the path `ladder`: `ladder done` waits for a review and a pull request, any other status
waits for a decision. An open pull request is a row with the path `pr`: ready when its checks are
green, open and blocked when one failed, open and running while they are pending. Nothing is joined: a
ladder run and a pull request are two rows. `EXPECT` on a ladder row reads
`expect not recorded in .construct/runs.jsonl`, because the ledger holds none, and `ACTUAL` reads the run's
`tokens <n>, seconds <s>`; on a pull request row both read `—`. `--json` carries neither. An open row older than 4 hours is stale, and its `NEXT` starts with `stale` and its age. A row that waits for you is red on `STAGE` and `NEXT`
and nowhere else, and a plain run (`--plain`, `NO_COLOR`, a pipe) carries no colour at all. A pull
request merged in the last 12 hours is named on the `merged:` line, never as a row.

A run the ladder finished more than 12 hours ago, a run followed by a later run of the same task, and
a closed pull request are hidden and shown by `--all`; when any row is hidden the `merged:` line ends with `   (older: --all)`, and with no merged
pull request it reads `merged: —   (older: --all)`.

With nothing open the board prints two lines in place of the table. The first names what was read: the
ladder runs in `.construct/runs.jsonl` when this repository has `/implement`, and the pull requests,
or that they were not read together with the `gh` command to run. The second says how to start one in Claude
Code, or that this repository has no `/implement` and the board lists pull requests only.

`--json` prints one object with `schemaVersion`, `format` (`user-board/1`, the format of this
output), `summary`, `sources`, `rows` (every row, hidden ones included, as `task`, `path`, `stage`,
`state`, `at`, `next`, `tone`, `stale` and `shown`) and `unknown`. `unknown` tallies what could not
be read, as the keys `.construct/runs.jsonl` (counting 1 when absent, and 1 for each malformed line)
and `pull requests` (counting 1 when `--prs` is missing or unreadable), and is empty when everything
was read. The text never prints UNKNOWN. A `--prs` file that cannot be read is named unreadable
with its reason, and the board still exits `0`.

## construct graph

Draws `construct.model.json` — every claim, every hypothesis and the files each one stands on — as a
Mermaid flowchart on **stdout**, so it pipes:

```bash
npx mikoshi-construct graph > model.mmd
```

The Mermaid on stdout is the machine-readable artifact and is the default, so there is no `--json`:
a diagram a program reads is already the JSON of this command.

**`--out <path>` also writes one self-contained HTML file**, so the same graph can be opened rather
than piped:

```bash
npx mikoshi-construct graph --out picture.html
```

That file is the whole picture. The graph is an inline SVG drawn from the same structure the Mermaid
is serialized from, the styling is inline, and **nothing is fetched when you open it** — no CDN, no
script, no network of any kind, from a `file://` URL or anywhere else. It is a few kilobytes, and it
carries a legend for the four classes — the three states and `runtime-report` — and the state of each entry in the entry itself, in its colour
and in its own words. Under that legend the page says what the colour is **not**, and this reference
repeats that line rather than restating it: *Colour carries the derived state and not the enforcement
level: the same green covers an L0 claim nobody is obliged to read and an L3 claim that fails the
build, and each claim’s level is written inside it.*

`--out` adds to stdout and never replaces it: the Mermaid is written exactly as it was before, and
the file is written afterwards. Where a reading draws nothing, no file is written either.

The states in the labels are the ones `doctor` reports, derived on read by the same code and stored
nowhere, with one named exception: a fact of kind `report-covers` or `report-misses`, and every
claim or hypothesis that names one, is drawn as `runtime-report` and never evaluated, because a
report is written per run and never committed. `doctor` reads it at run time. A claim carries its declared enforcement level and the state of each stage, a hypothesis
carries its state, and a fact carries whether it holds where it was read. A fact several entries
stand on is drawn once, with one edge from each of them. `held` is not proof that the level is right,
`unsupported` says the named evidence no longer matches and nothing more, and `unknown` says nothing
was read.

Four readings, and only the first draws anything:

| Reading | Where it goes | Exit |
|---|---|---|
| The model carries entries | the diagram, on stdout — and the page, where `--out` names one | `0` |
| `construct.model.json` is here and names no fact, claim or hypothesis | a line on stderr, nothing on stdout, and no file written | `0` |
| There is no `construct.model.json` here | a line on stderr, nothing on stdout, and no file written | `0` |
| `construct.model.json` declares a `modelVersion` this binary does not understand | the state named on stderr, nothing on stdout, and no file written | `1` |

The first three exit `0` because absence is not obstruction; the fourth is obstruction — the file is
there and could not be read — and exits `1` like every other reading of a record from a later build.
The messages go to stderr rather than into
the diagram: `construct graph > picture.mmd` on a repository with no model leaves an empty file and
says why on the terminal, never prose inside the file.

The picture renders the model and does not interpret it. Opening the file is not reading it, and a
file on disk is no evidence that anyone looked at it — which is the condition
[decision 0017](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0017-v5-adds-no-new-way-of-knowing.md)
puts on anything interactive being built on top.

This repository renders its own picture into
[architecture/model.md](https://github.com/E1i/mikoshi-construct/blob/main/architecture/model.md)
through the same function the command calls, so the committed block and the command agree by
construction.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The command did what it said. `detach` with nothing attached, `graph` with no model to draw and every `soulkill` exit `0`. |
| `1` | `init` was declined, had no terminal without `--yes`, refused a preset that contradicts the detected stack, or failed; `attach` refused, was cancelled or had no terminal (`attach --entry` exits `0`); `detach` refused; `doctor` found a missing baseline file or a broken harness, found no `construct.json`, or found one written by a later build; `sync` found no `construct.json` or failed to write; `cost` could not match the directory to the recorded project key (`mismatch` or `unknown`); `mutate apply` or `mutate judge` refused. |
| `2` | `sync` classified at least one path as `add` or `update`; under `--apply`, one of them was refused because it is a `merge-json` target; `mutate judge` found an outcome that does not match the prediction, or no witness. |
| `3` | `cost` ran under a runtime that does not expose per-run token usage (`unsupported`); `mutate judge` met a hard failure. |

### The recorded surface

The commands and their aliases, the flags, the exit code per command and state, the key paths each
`--json` prints in each state, the format versions, the paths `init` and `attach` write and the block
markers are recorded in `contract/surface.json`
([decision 0030](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0030-public-contract.md)).
A test compares the file with what the code produces and never writes it; `pnpm contract:update`
is the only command that does, and its diff goes into the pull request that changes the surface.

`pnpm contract:bump`, a CI job, compares `contract/surface.json` at the latest release tag
reachable from `HEAD` with the file at `HEAD` and fails when the pull request declares a weaker bump
than the change requires. Before 1.0 an addition requires at least a patch and a removal, rename or
changed value at least a minor; from 1.0, minor and major. Satisfy it with a changeset of that level
for `mikoshi-construct`; the version pull request declares the difference between its two versions.

## After init

`init` writes the files and stops. The rest of the lifecycle belongs to the agent and to the harness:

```bash
pnpm install && pnpm run quality   # the gate, green from the first run
claude                             # then /construct-discover
```

`/construct-discover` fills the ten markers in `AGENTS.md` and `architecture/` by reading the code.
`/plan` turns a feature into tasks with acceptance criteria, each shown failing before the
implementation exists. `/implement` runs the reasoning-budget
ladder and lets the harness decide when more effort is warranted. Cursor users ask the agent to run
construct discovery instead, and it follows the same protocol.

When a later release arrives, the repository moves onto it through
[the upgrade loop](/guide/upgrading), never through a second `init`.
