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

## construct init

Detects the repository, asks what it cannot detect, then writes the construct: architecture policy,
the harness, an API contract where the preset has one, and the agent instructions. It ends by
printing what to run next.

| Option | Default | What it does |
|---|---|---|
| `--preset <id>` | asked | `node-backend`, `node-frontend`, `node-library` or `monorepo`. |
| `--ai <target>` | `claude` | `claude`, `cursor` or `both`. Decides whether you get `.claude/`, `.cursor/rules/` or both. |
| `--name <name>` | directory name | The project name written into `package.json` and the agent files. |
| `--review <provider>` | `none` | `claude` adds the label-triggered review workflow. It needs a `CODE_REVIEW_API_KEY` secret. |
| `--review-model <model>` | `claude-sonnet-5` | The model that review workflow runs. |
| `--yes`, `-y` | `false` | Ask nothing. Take the defaults and skip the confirmation. |
| `--dry-run` | `false` | Print the plan and write nothing. |

Without `--yes` and with a terminal attached, `init` asks only for what the flags left open. Piping
input without `--yes` is refused rather than guessed at.

Exits `0` when it writes or when `--dry-run` finishes, `1` when you decline the confirmation or when
the target cannot be read.

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

`init` writes every marker as `unknown` with no sha: it fills no marker, so it claims none.
`/construct-discover` records `baseSha` — the commit the run started from — when it starts, `filledAt`
when it finishes, and for each marker it fills the file, `authoredBy: "construct"` and the sha256 of
the body it wrote. The body is the text between the two `construct:discover` comments, trimmed; for
`composition` it is every `*.yaml` in the directory, sorted by name, each as its filename, a newline
and its contents. Nothing is written into the prose of a marker: a document people read does not carry
machine bookkeeping, and the one place an owner is most likely to edit is the worst place to keep the
record.

## construct doctor

Checks that the construct is intact: every file the manifest recorded is still present, the harness
script `construct.json` names is still there, the contract paths it records still resolve, and each
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
| `modifiedFiles` | provenance |
| `unreadableFiles` | provenance |
| `missingDiscovery` | provenance |
| `provenance` | provenance |
| `harnessProblems` | provenance |
| `uncollectedTests` | provenance |
| `warnings` | provenance |
| `checks` | knowledge |
| `hypotheses` | knowledge |
| `youAreHere` | knowledge |
| `versionGap` | provenance |

`harnessProblems` carries provenance only: `package.json` is gone, it has no script under the name
`construct.json` recorded, or a contract path that manifest points at is absent. Each of those goes
false only when what `init` installed changed. Whether the harness command really runs its steps is
knowledge — the owner's `package.json` can drop `pnpm lint` with no construct file touched — so it
is the `harness-steps` claim, rendered as a verdict like any other.

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
| `no-claim` | `construct.model.json` was read and names no claim: it asserts nothing about this repository. | `You are here: construct.model.json carries no claim, so there is none to place` |
| `no-stop` | The model carries claims and none of their chains stops before its end. | `You are here: no claim stops before the end of its chain` |
| `stop` | The first claim whose chain stops, carried under `stop` with the stage and the facts behind it. The line names the **first** fact the stage declares in its `supportedBy` — the same declared-order key that breaks a tie between claims, so the line is stable between runs and diffs — and counts the rest, so it stands on its own where it is read apart from the section above; the full list stays in the verdict. A stage that could not be read names no fact: nothing was established about it, so there is nothing that stopped matching to name. | `You are here: <claim> — <stage> unsupported: <fact> no longer matches, and 2 more` |

Under the first two the Enforcement section says why it lists nothing, instead of an empty list a
reader would take for a repository that was looked at and found clean. None of the four moves the
exit code: a repository with no model exits `0`, because absence of a subject is not obstruction.

### What the model holds open

`hypotheses` carries one entry per hypothesis in `construct.model.json`, in the model's declaration
order, each with the `statement` discovery wrote, the base it was read from (`baseSha` and
`baseClean`) and the state derived from the facts named under it — the same derivation the claims
use, so a hypothesis reads `held`, `unsupported` with the paths that no longer match, or `unknown`.

`unknown` keeps its two origins apart here as everywhere else. A hypothesis whose facts could not be
read carries `reason: "unevaluable"` and the paths it could not read; a hypothesis with nothing named
under it carries `reason: "no-fact-named"`, and the report says so in as many words rather than
letting it read like a fact that failed. Neither moves the exit code: a hypothesis is what the
repository was taken to be, not something it promises.

An empty list is not a repository whose readings all stand. The section names which of the two it is
— there is no model at all, or the model was read and holds nothing open — the same way `youAreHere`
does for claims.

`baseClean: false` says the hypothesis was read from a tree carrying uncommitted changes, so it was
never read from the commit it records, and the line for it says that beside the reading.

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
| `no-committed-secret` | `no-committed-secret` | Always, since every preset makes that claim |
| `vulnerable-dependencies-are-visible` | `vulnerable-dependencies-are-visible` | Always |
| `ci` | `every-change-passes-the-harness` | Always |
| `harness-steps` | `harness-steps` | Always |
| `lint-policy` | `lint-policy` | Only where the model carries that claim, which is where the preset's sample was materialized and the construct wrote the policy test it stands on. Absent from the output otherwise, rather than reported as missing |
| `a-breaking-api-change-is-named-before-it-ships` | the same claim | Only where the preset materializes an HTTP contract |

A preset that declares no syntax policy makes no `lint-policy` claim, so no verdict is rendered for
it: the construct required nothing there, and announcing the absence of something nobody required
would be a finding about a task. `node-library` is such a preset — its harness is the shared ESLint
configuration with no restriction of the construct's own.

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
  "ok": true,
  "missingFiles": [],
  "modifiedFiles": [],
  "unreadableFiles": [],
  "missingDiscovery": ["product", "module-map"],
  "provenance": [
    { "marker": "product", "file": "AGENTS.md", "authorship": "unknown" },
    { "marker": "commands", "file": "AGENTS.md", "authorship": "construct" },
    { "marker": "composition-roots", "file": "AGENTS.md", "authorship": "owner" }
  ],
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
      "baseClean": false,
      "state": "unsupported",
      "doesNotHold": ["apps/api/package.json"]
    },
    {
      "hypothesisId": "deployed-as-a-single-container",
      "statement": "This repository is deployed as a single container",
      "baseSha": null,
      "baseClean": true,
      "state": "unknown",
      "reason": "no-fact-named"
    }
  ],
  "youAreHere": { "at": "stop", "stop": { "claimId": "every-change-passes-the-harness", "stage": "enforcement", "state": "unsupported", "doesNotHold": [".github/workflows/ci.yml"] } },
  "versionGap": { "materializedBy": "0.1.0", "readBy": "0.2.0", "pending": 3 }
}
```

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
| `foreign` | The tree carries it, no record and no template does. Not the construct's to discuss. | counted only |

`keep` is the quiet majority and `foreign` is not ours to discuss, so both are counted and neither is
listed. A `merge-json` target — `package.json` — is reported by the keys that differ, and merged
files are not written in this version at all, which is why `package.json` never appears among the
writable paths.

`unknown` is the reading of a block whose provenance the record cannot settle. `AGENTS.md` and
`CLAUDE.md` ship in two variants — the one `init` writes into an empty directory and the one it
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

### Exit codes

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

`--json` prints one object with `fromVersion`, `toVersion`, `counts` (one entry per class) and
`paths` — every classified path with its `class`, its `strategy`, its `keys` for a `merge-json`
target and its `writeEffect` where the classification carries one. A machine reader never parses the
prose. With `--apply` the same object carries three more fields:
`written` (the targets that were written, in write order), `pending` (the targets classified `add` or
`update` that were refused) and `ranAt` (the ISO timestamp recorded in the manifest).

```json
{
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

## construct soulkill

Prints what the detector sees and writes nothing. It is the same code `init` runs, so it is also how
you debug a preset suggestion you did not expect. Aliases: `inspect`, `capture`.

| Option | Default | What it does |
|---|---|---|
| `--json` | `false` | The detect report as JSON. |

```bash
npx mikoshi-construct soulkill
```

```
>> Inspecting repository...

  ├─ Directory: /srv/projects/my-service
  ├─ Runtime: Node.js 24
  ├─ Package manager: pnpm (pnpm 12.4.2 installed)
  ├─ Layout: monorepo (pnpm-workspace)
  ├─ Workspace dirs: apps, packages (7 packages)
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
run total is printed twice: billable tokens, and an input-equivalent figure that weights cache writes
at 1.25, cache reads at 0.1 and output at 5, so a cheap run and an expensive one can be compared at a
glance.

The runtime is resolved first — from the environment the command runs in, otherwise from the `ai`
target in `construct.json` — and only then asked for its usage. A runtime whose per-run usage is not
readable (Cursor, for instance, which keeps no such session files) is reported as `unsupported`,
never as an absence of runs.

`--json` prints one object: `status` (`ok`, `empty`, `unsupported`, `mismatch` or `unknown`),
`runtime` (`claude-code` or `cursor`), `key` and `candidates` where the project key is in question,
`runs` when there are any, and `ledger` and `reconciliation` as described below.

### The run ledger

`.construct/runs.jsonl` is the ladder's own journal: one JSON line per `/implement` run, appended by
step 4 of the `implement` skill. That step is an instruction in a prompt — nothing makes it happen
and nothing notices when it does not — so the ledger is **L0** on the scale `doctor` reports: a
record nobody is obliged to keep. Read it as a claim to be checked, never as a complete history of
what ran. Decision 0003 records why it stops there.

Each line carries exactly these fields:

| Field | Meaning |
|---|---|
| `run` | The Workflow run identifier the runtime reported for the run. This is the join key. |
| `at` | ISO timestamp of the run. |
| `task` | The task text, first 120 characters. |
| `effort` | The effort class the caller chose before the run. |
| `status` | `done`, `failed` or `blocked`. |
| `rung` | The effort of the rung that finished. |
| `attempts` | One object per attempt: `rung`, `effort`, `outcome`, and a `reason` separating an invalid response shape from a red harness from a blocked report. |
| `agents`, `tokens`, `toolUses`, `seconds` | The Workflow tool's accounting for the whole run. `tokens` may be the string `unknown`; it is never rewritten as `0`. |

The Workflow tool reports accounting per run, not per agent, so the ledger declares no per-agent
field. It carries counts and reasons only — never a prompt or a response, which keeps the invariant
that cost reads token counts and never message content.

A line that does not parse, or that is missing a declared field, is reported as malformed with its
line number rather than skipped: a ledger that quietly drops what it cannot read is worse than no
ledger.

### Reconciliation

Where the runtime exposes session data, `cost` joins ledger entries to runtime runs on `run` and
reports the drift in both directions — never by pairing entries to sessions chronologically, which
would be a guess dressed as a finding:

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
| `mismatch` | `1` | No directory for the looked-up project key, but the path this directory resolves to — or the main worktree it belongs to — has one. The report names the key that was looked up. |
| `unknown` | `1` | Sibling keys look like this repository without settling it; the report says so rather than guessing. |
| `unsupported` | `3` | This runtime does not expose per-run token usage. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The command did what it said. |
| `1` | `init` was declined or failed; `doctor` found a missing baseline file or a broken harness; `sync` found no `construct.json` or failed to write; `cost` could not match the directory to the recorded project key (`mismatch` or `unknown`). |
| `2` | `sync` classified at least one path as `add` or `update`; under `--apply`, one of them was refused because it is a `merge-json` target. |
| `3` | `cost` ran under a runtime that does not expose per-run token usage (`unsupported`). |

## After init

`init` writes the files and stops. The rest of the lifecycle belongs to the agent and to the harness:

```bash
pnpm install && pnpm run quality   # the gate, green from the first run
claude                             # then /construct-discover
```

`/construct-discover` fills the ten markers in `AGENTS.md` and `architecture/` by reading the code.
`/plan` turns a feature into tasks with acceptance criteria. `/implement` runs the reasoning-budget
ladder and lets the harness decide when more effort is warranted. Cursor users ask the agent to run
construct discovery instead, and it follows the same protocol.

When a later release arrives, the repository moves onto it through
[the upgrade loop](/guide/upgrading), never through a second `init`.
