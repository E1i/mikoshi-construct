# 0033 — `checked` means the harness ran the target's own verification surface, not that it exited 0

Status: accepted · 2026-09-25

## Context

`doctor` reports `harness.state: checked` for any harness command of the package-script form, and the
model's claims about the harness read `held` from what `package.json` and `ci.yml` spell out. Neither
looks at which repository the harness actually verified.

The observation *Blindspot's first catch was its own decision claiming more than the code*
([observations.md](../observations.md)) named the class: a record telling its reader what the tool
does, with nothing able to fail on it. Measurement ②a of the decoupling found the same class in
`doctor` itself, on a synthetic Python service (Django and Flask, pytest tests, plus a `package.json`
for static assets, which lets `init` through):

- `init` recorded `harness: pnpm run quality`, and `pnpm run quality` exited 0 with *Test Files 4
  passed, Tests 13 passed*. All 13 were the construct's own tests under `scripts/tests/`. The
  repository's three pytest tests were run by nothing in the harness.
- `doctor` then read `ok: true`, `harness.state: checked`, and all five construct claims `held`,
  `harness-steps` at L3 among them.
- Discovery saw the gap and wrote it into open-questions, but could not write it into the model: the
  two fact kinds, `file-exists` and `file-contains`, cannot state that something does *not* happen.

So `checked` answered "the command has the shape of a package script". A reader takes it to mean "the
harness verified this repository", and on a repository whose own tests the harness never touches
those two come apart completely. A green run of the wrong suite is the most dangerous case, because it
produces exactly the evidence a correct run produces.

## Decision

### 1. What `checked` means

`harness.state` is `checked` **only when it is observable that the harness ran at least one element of
the target repository's own verification surface.** A run that exited 0 without touching that surface
is not `checked`, whatever it printed.

- **The verification surface** is a set of repository files named by globs, minus every path the
  construct recorded as its own write (`construct.json` → `files` and `sync.files`). The construct's
  own tests are never the target's surface, whatever a glob matches. That subtraction is what makes
  the ②a run read correctly and not as coverage.
- **An element was run** when the harness report lists it as executed. An element the report lists as
  skipped was not run. A failed element was run: `checked` is about coverage, not outcome, and whether
  the harness passes stays outside what `doctor` says ([0007](0007-doctor-executes-nothing.md)).
- `harness.state` takes three values:
  - `checked` — observed coverage of at least one surface element;
  - `does-not-cover` — observed absence of coverage, under the full-scope conditions in section 3;
  - `unknown` — everything else.
- `does-not-cover` is knowledge, not provenance. Like every other unsupported claim it never makes
  `ok` false: `ok` still answers whether the inspection completed.
- The old meaning of `checked`, "the command is a package script", is withdrawn and not moved to
  another value. What it guarded, the script's presence in `package.json`, is already reported by
  `harnessProblems`, and that does not change.

### What this record guarantees, and where it stops

This record guarantees **honesty on every repository**: `harness.state` never reads `checked`, and no
claim resting on the facts below reads `held`, unless coverage of the target's own surface was
observed. On any repository whose report nothing can read, the only possible readings are
`does-not-cover` and `unknown`.

It does **not** guarantee that `checked` is reachable everywhere. `checked` needs a reader for the
report's format, and the only reader this record relies on is the one already in the tree, for Vitest
JSON. So `checked` on a repository whose harness writes any other format, and with it the positive
half of clause 1 on a non-Node repository, is outside this record. It arrives with the first
follow-on adapter, a report reader for a non-Node format (candidate: JUnit XML, which pytest and most
other ecosystems' runners write natively), and that adapter carries its own witness.

### 2. A fact can state what does not happen

The model gains three fact kinds. `modelVersion` becomes 2, and a reader that knows only version 1
reports the model as ahead of it ([0028](0028-a-model-ahead-of-the-reader-is-a-state.md)).

| Kind | Properties | `holds` | `does-not-hold` | `unevaluable` |
|---|---|---|---|---|
| `file-lacks` | `path`, `needle` | the file was read and the needle is absent | the needle is present | the file is missing or unreadable |
| `report-covers` | `path` (the report), `surface` (globs) | conditions 1 and 2 of section 3 are met, and at least one executed report entry resolves to a surface file | every condition of section 3 is met, and no executed entry resolves to a surface file | any condition of section 3 is not met |
| `report-misses` | `path`, `surface` | exactly where `report-covers` does not hold | exactly where `report-covers` holds | exactly where `report-covers` is unevaluable |

- **Negation never turns "could not look" into an observation** ([rule 2](../epistemic-rules.md)).
  A `file-lacks` on a missing file is `unevaluable`, not `holds`: the needle's absence was never
  observed, only the file's. That is why negation is written as its own kinds with their own
  `unevaluable` column, and not as a flag that flips `holds` and `does-not-hold`.
- **A missing report is `unevaluable`, not `does-not-hold`.** This is unlike `file-contains`, where a
  missing file does not hold. A report is written by the runner ([0031](0031-the-cli-owns-the-mutation-the-runner-owns-execution.md)),
  so its absence says the runner has not run, not that coverage is absent.
- `report-covers` and `report-misses` are two readings of one observation, not two sources for it.
  A claim stands on `report-covers` and reads `unsupported` when coverage is absent. A hypothesis
  written by discovery stands on `report-misses` and reads `held` when discovery's finding is true.
  This is the record ②a could not write: "the harness does not cover the target's tests".

### 3. How `doctor` observes the link between harness and target

`doctor` runs nothing ([0007](0007-doctor-executes-nothing.md)). It reads a report the runner wrote,
through a reader for the report's format ([0031](0031-the-cli-owns-the-mutation-the-runner-owns-execution.md)),
and intersects the files the report executed with the surface. Exit 0 is not evidence of anything
here.

A report is evidence only when all of these hold. Any one of them failing makes it `unevaluable`:

1. The report file exists and a reader for its format parsed it completely.
2. It is newer than every file in the surface. A surface file changed after the report is a change
   the report did not see.
3. For `does-not-hold` only, which asserts absence: **every** entry in the report resolved to a
   repository path. One entry that cannot be mapped means the intersection was not taken over the
   whole report, and absence is asserted only with full-scope evidence ([rule 2](../epistemic-rules.md),
   [0014](0014-a-check-answers-only-about-what-it-was-shown.md)). `holds` needs no such condition:
   one resolved entry in the surface is positive evidence, however many others are unreadable.
4. The surface, after subtracting the construct's own paths, contains at least one file on disk. An
   empty surface cannot be covered or missed.

Every failure of this list collapses toward `unknown`, never toward `checked` or `does-not-cover`.
Freshness is judged by file time, which a checkout resets. That makes a report read as stale more
often than it is, and staleness only ever produces `unknown`.

A report reader maps a report to executed and skipped repository paths. The format already in the
tree, Vitest JSON, is read by `mutate`, and the same reader serves `doctor`. A report in a format with no
reader is `unevaluable`.

### 4. The claim, and who writes it

`harness.state` is a projection of one claim, `harness-covers-target`
([0016](0016-the-model-is-the-source.md)). Its verification stage stands on a `report-covers` fact.
The mapping is:

- `held` → `checked`;
- `unsupported` → `does-not-cover`;
- `unknown`, or the claim absent → `unknown`.

**The construct never writes this claim.** Only discovery can name a repository's own verification
surface. That is interpretation ([0015](0015-interpretation-stays-with-the-agent.md)), and a surface
the construct wrote would be a guess.

Consequently, every repository reads `harness.state: unknown` until discovery writes the claim and a
runner writes a report. That includes Node repositories that read `checked` today. It is the honest
reading: nothing had observed their coverage either.

The claims `harness-steps` and `every-change-passes-the-harness` keep their meaning. `held` there says
the harness is wired, that its script names its steps and that CI runs it. It says nothing about which
repository those steps verify. They are not moved, narrowed or renamed.

## Consequences

This record merges before the change that implements it, so each item below describes the behaviour
once that change lands. Until then `main` behaves as the Context section describes.

- A green run of the construct's own tests no longer reads as coverage of the target. On the ②a
  repository, `harness.state` reads `does-not-cover` once discovery names `tests/**/test_*.py` and a
  Vitest report exists, and `unknown` before either.
- The public contract changes in two places, both under [0030](0030-public-contract.md):
  - `doctor --json`: `harness.state` gains `does-not-cover`, and `checked` changes meaning. A
    consumer that read `checked` as "a package script" gets `unknown` on the same repository. That is
    a breaking change of a value's meaning, declared as one, and it ships as a `minor` under the
    pre-1.0 rule.
  - `formats.modelVersion` goes from 1 to 2.
- Discovery gains the means to record a negative finding. Teaching the discovery protocol when to
  write `harness-covers-target`, and with which surface, is a separate change to the protocol
  template. Until it lands, repositories read `unknown`, never `checked`.
- **This repository reads `checked` on itself.** mikoshi-construct's own `doctor` must read `checked`
  honestly: Vitest covers the repository's own surface. The implementing change records
  `harness-covers-target` in this repository's `construct.model.json`, authored as discovery, with
  surface `tests/**/*.test.ts` and the Vitest JSON report the harness writes. The construct's own
  recorded paths are subtracted, as on any repository. CI witnesses it on every change, so the
  construct's own gate does not quietly drift to `unknown`.
- The `doctor` steps in CI's preset acceptance run on freshly initialised trees, which carry no
  discovery-authored claim. By section 4 they read `unknown`, and `unknown` does not make `ok` false.
  That is the honest reading of a tree nobody has discovered yet.
- Which surface globs and which report path a repository uses are not recorded in `construct.json`.
  They live in the fact, where discovery writes them and where `doctor` reads them. That keeps one
  source ([0016](0016-the-model-is-the-source.md)).

## Not in scope

- The adapters of the decoupling, `detect`, `init` and `mutate`, and how `init` learns a harness that
  is not pnpm.
- The entry gate that `services/` gets past (#232).
- Any report reader beyond the Vitest JSON one already in the tree, and therefore `checked` on a
  repository whose harness writes another format. It is the first follow-on adapter. See *What this
  record guarantees, and where it stops*.

## Enforced by

Until the implementing change lands, this record is L0 text. The lesson of 0032 applies directly: a
decision merged before its code claims more than anything checks. So every clause is listed here with
the witness the implementing change must add. Each witness is red on `main` before the change
([0027](0027-an-acceptance-is-red-before-the-implementation-exists.md)) and red again under the named
wrong implementation ([0029](0029-an-acceptance-is-red-under-a-named-wrong-implementation.md)).

**The fixture** is the ②a Python service, frozen under `tests/fixtures/`. Its Vitest report is
captured from a real run on that repository, not written by hand.

| Clause | Witness (L3) | Wrong implementation it must catch |
|---|---|---|
| A green run of the construct's own tests is not `checked` (1) | ②a fixture, Vitest report, surface `tests/**/test_*.py` → `does-not-cover`. On `main` it reads `checked`, so the test is red today. | — |
| The construct's own paths are never surface (1) | the same fixture with surface `**/*` → `does-not-cover`, not `checked`: the Python files remain after subtraction, and every file the real report executed is construct-recorded | the subtraction removed → `checked` |
| Skipped is not run (1) | the Node fixture `tests/fixtures/verification/node-service`, whose only surface entry the report lists as skipped → `does-not-cover` | skipped entries counted as run → `checked` |
| A failed element was run (1) | the same Node fixture, whose surface entry the report lists as failed → `checked` | outcome read instead of coverage → not `checked` |
| `does-not-cover` never makes `ok` false (1) | the first row's fixture → `ok: true` | — |
| No claim → `unknown` (4) | a fixture model without `harness-covers-target` → `unknown` | — |
| The construct never writes the claim (4) | `init` on every available preset → the model carries no `harness-covers-target` | — |
| A missing report → `unknown` (2, 3) | the fixture without its report → `unknown` | a missing report treated as `does-not-hold` → `does-not-cover` |
| Freshness (3.2) | a surface file newer than the report → `unknown` | freshness ignored → `does-not-cover` |
| Full scope for absence (3.3) | one unmappable entry and no surface hit → `unknown` | unmapped entries treated as outside the surface → `does-not-cover` |
| Empty surface (3.4) | a surface glob matching no file → `unknown` | — |
| `report-misses` is the exact negation (2) | the hypothesis on the ②a fixture → `held`; the `unknown` rows above → `unknown` | — |
| `file-lacks` on a missing file is `unevaluable` (2) | missing file → `unknown`; file without needle → `held`; with needle → `unsupported` | a missing file read as `holds` → `held` |
| `modelVersion` 2 (2) | a version 2 model read by a reader of version 1 → the ahead-of-reader state (0028); `contract:bump` over `formats.modelVersion` | — |
| This repository reads `checked` on itself (Consequences) | a CI step writes the Vitest JSON report, runs `doctor --json` on this repository and fails unless `harness.state` is `checked` | the claim missing from this repository's model → `unknown`, and CI goes red |
| Honesty on a non-Node repository (guarantee) | on every variant of the ②a fixture in the rows above, `doctor` reads `does-not-cover` or `unknown` and never leaves its coverage claim `held`, and `construct graph` never draws that claim's verification `held` | — |

**Not witnessed here, by design:** `checked` from a non-Node report. It is outside this record and is
witnessed by the adapter that makes it reachable.

**Stays at L1 review:**
- Whether a repository's surface globs name the right files. That is discovery's interpretation, and
  nothing mechanical can tell a well-chosen surface from a narrow one.
