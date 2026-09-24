# Observations

Decisions are stable; observations accumulate, sharpen and go stale. Keeping them apart is why this
file exists. A decision records what was settled and why, and is amended only when the decision
itself changes. An occurrence of something a decision already describes is recorded here, and the
decision points at this file rather than growing a log inside itself — a record that accumulates
entries eventually gets tidied, and tidying a log into the text of a decision adds scope to it
retroactively, which [epistemic-rules.md](epistemic-rules.md) forbids in its header.

Each entry carries a date, what was observed, and the boundary of what it supports. **An observation
is not a frequency.** Two occurrences of the same failure are two occurrences; the population here is
far too small to carry a rate, and nothing causal is claimed from any of it. The findings corpus
proper lives in a separate private repository
([decision 0001](decisions/0001-findings-corpus-outside-the-cli.md)); this file is what that corpus
can point at.

Every specimen here is described by structure and never by address, and quoted tool output is either
reproduced as captured or replaced by a description — never edited to look like a capture. Both rules,
and the exemption for frozen fixtures, are
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md).

**One entry refers to another by its heading, never by direction.** New entries are inserted near the
top, so "the entry above" has a lifespan of one insertion and falsifies itself in whatever diff adds
the next record — which has already happened here, inside the commit that caused it. A reference by
name lives as long as the entry does. The exception is stated so that it does not have to be
rediscovered: **within a single entry, a directional reference is fine**, because nothing gets
inserted between a paragraph and the lines above it in the same record. Between entries it is not.

## 2026-09-24 · The Shredder signal: splitting ladder tasks for parallel runs is not needed

**Question.** Across past ladder plans, are the tasks cut into pieces whose file paths do not overlap,
so that they could have run in parallel? For each plan, P = W / S: W is the summed weight of its pieces;
S is the weight of the heaviest connected component, where pieces sharing a path are glued. The measure
is how often P > 1.5.

**Instrument.** A `/plan` output carries no paths, so a piece is one ladder run and its paths are the
`files` the run reports. The final ladder result is read from the session transcript's task
notification, because `journal.jsonl` holds only per-agent results. Where no final result exists, the
union of the implementer results' `files` is used. Weight is subagent tokens, with wall seconds as a
second reading. The corpus is 71 `/implement` runs, 62 of which report `files`. Two groupings were
used: a plan is the runs of one session (the definition asked for), or the runs traced by hand to one
of the four `/plan` outputs.

**Result.**

- By session: 0 of 2 measured sessions have P > 1.5; both have P = 1.00. The other three sessions have
  pieces with no weight and are unmeasured.
- By `/plan` output: 1 of 4, the v5.0 model plan, with P = 2.05 on tokens and 1.93 on seconds.
- That one value is produced by the instrument. `files` lists only the paths a run wrote. In today's
  tree, the plan's four "independent" pieces import one another's modules, and one test imports three
  of them. Counted with import edges, the plan is one chain.
- Dropping mechanically generated outputs (`contract/surface.json`, the rendered composition blocks)
  changed no P.
- No two of the 64 runs with an end time overlapped. P therefore measures a counterfactual, not a
  practice.

**Verdict: the signal says a splitter is not needed.** No plan offered real parallel work that the
ladder left unused.

**Separately: what glues the pieces is two shared files, not the tasks.** `docs/cli.md` is written by
29 runs and `src/ui/lore.ts` by 24. Pieces whose own paths are unrelated become one component because
each of them adds a paragraph to the command reference and a string to the vocabulary. So the
coupling sits in the two files that collect every command's prose. The tasks themselves did not
overlap.

**Boundary.**

- Two measurable sessions and four `/plan` outputs; nothing here is a rate.
- A failed rerun with no files becomes a component of its own and inflates P. That alone lifts one
  plan to 1.14.
- The two largest sessions are working days that mix several plans.
- Written paths are not read paths. The only P > 1.5 shows what that costs.

## 2026-09-24 · A vitest report named a test file from a nested worktree, once, and was not reproduced

**Observed once.** From the main checkout, `pnpm exec vitest run tests/strategies.test.ts
--reporter=json` returned a report whose only test file was the copy of that file inside an agent
worktree under `.claude/worktrees/`, not the checkout's own. The worktree had its own `node_modules`,
and the agent working in it may have been running vitest at that moment.

**Not reproduced.** Three attempts against a nested worktree, each at the same HEAD, with the same
command and with `vitest list --filesOnly`:

- under `.claude/worktrees/`, without `node_modules`;
- the same, with `node_modules` installed;
- in a directory without a leading dot.

All three saw only the checkout's own 102 files. vitest's `include` (`tests/**/*.test.ts`,
`scripts/tests/**/*.test.ts`) is anchored at the root, and a file filter only narrows within it. That
explains why the sighting did not repeat. It does not explain why it happened.

**Untested remaining difference.** A vitest run going on inside the nested worktree at the same
moment. **No vitest exclusion is added until the case is reproduced**: an exclusion guarding against
an unknown cause could only be tested for being present, not for being needed. The same
investigation found the eslint half, which was real: eslint lints a nested worktree whenever its
directory has no leading dot. That half is fixed and tested under #204.

## 2026-09-24 · An acceptance line was agreed and then left out of the arguments the ladder received

**Observed.** The owner and the orchestrator agreed a `/implement` line for the `construct mutate`
pull request (#205). Its acceptance read: *the tests named in M1b–M8 are red before the code exists*.
The acceptance array the orchestrator then passed to the Workflow tool did not carry that line. It
said only that the eight named tests exist under those names and pass. The ladder finished `done` at
medium on its first rung, reported no red-before record, and was never asked for one. The harness
checks what the acceptance array names, so nothing signalled the gap. It surfaced when the owner asked
for the red-before record after the pull request was open.

**Where the item was lost.** Not inside the ladder, and not in the harness. It was lost in the step
that turns an agreed line into the Workflow tool's `args`, which the orchestrator writes by hand and
nobody compares with the line. The pull request carries named mutations as its witnesses instead: all
nine went red as predicted. The red-before record 0027 asks for does not exist for this change.

**Candidate, not adopted.** The harness requires a red-before record whenever the acceptance names
one. It would not have fired here, because the acceptance it would read had already lost the line.
A remedy has to reach the translation step: for example, the ladder script echoes back the acceptance
it received, so the owner compares it with the agreed line before the run is counted. One occurrence;
no rate is claimed.

## 2026-09-24 · A detach test went red once during a mutation run that did not touch detach

**Observed.** During the mutation runs for `construct mutate` (#205), the full suite under mutation M5
(`judge` restores even when the file's sha differs from the recorded one) showed four red tests. Three
belong to the mutation. The fourth was `tests/detach.test.ts › a4: attach then detach is the identity
on a clean repository`, and M5 changes nothing that detach reaches. The unmutated suite, run
immediately before as the control, was 1127 passed and 0 failed. Straight after M5, `detach.test.ts`
ran three times without the mutation, 24/24 each time.

**The failure's own message.** The red assertion was not an assertion at all. The test's `listing`
helper, which walks the temporary repository with a recursive `readdirSync` that includes `.git/`,
threw `ENOENT: no such file or directory, scandir '<tmp>/construct-detach-…/.git/objects/72'`. A
directory under `.git/objects` existed when the walk listed its parent and was gone when the walk
entered it. `listing` filters `.git/` out of its result only after the walk, so the walk enters `.git`
only to discard what it finds there. The whole window of this failure lies in entries the test throws
away.

**Candidate, not tested.** Some git process was still changing `.git/objects` while the snapshot was
taken, for example automatic maintenance that a previous git command started in the background and
that removes empty object directories. The listing races it. The failure then depends on timing and
load, not on the code under test, which fits a failure that went away on three immediate reruns. A
walk that does not descend into `.git` would remove the window without deciding which git process
opened it, and it changes nothing the test compares. One
occurrence in eight full-suite runs plus one control; no rate is claimed.

## 2026-09-24 · What the 0030 D2 self-check tells apart, and two things it does not look at

### What was observed

0030 D2 adds a CI step that computes the required bump for base `v0.17.2` against head `0f905ea` and
asserts two things: the line `required: minor (breaking surface change)`, and the reason
`jsonKeys.doctor.noManifest.root: null → object`. Five mutations were written down with predictions
before the run. The ladder's implementer ran all five. The operator re-ran M4 and M5 against the
finished tree, with mutations of their own wording; M1–M3 are recorded as the implementer reported
them.

| # | Mutation | Predicted | Observed |
|---|---|---|---|
| M1 | no generation; a tag with no file is an empty base | self-check red, required patch instead of minor, root reason absent | self-check red on the root reason only; required stayed minor |
| M2 | the generated base records no root | self-check red, root reason absent, required stays minor | as predicted; two `pnpm test` files also turned red, because HEAD and the tag share the sampler |
| M3 | the tag's file taken whatever its surfaceVersion; no file is an empty base | self-check red, required patch | self-check red on the root reason only; required stayed minor |
| M4 | the worktree left behind after a throw | the cleanup test red, naming the path | as predicted |
| M5 | a pair the tag could not be sampled for recorded as absent | the pair test red, additive instead of breaking | as predicted; the CI self-check stayed green, so only `pnpm test` holds it |

**M1 and M3 refuted the predicted level.** An empty base still reads `outside` as breaking, since
every item present at the head "leaves the contract", so required does not fall to patch. In the
unmutated run, `exits`, `markers` and `outside` are `unbaselined` in the generated base, and any one
of them makes the change breaking and the required level minor.

### What it supports

**The assertion `required = minor` does not tell any of M1–M3 from the correct code.** Both hold
minor for reasons unrelated to the mutation. The step's power to catch these three comes entirely from
the root reason. What the self-check is obliged to prove is a separate decision, not taken in D2.

Two further things the same work does, recorded as found:

- **The tag's preset list is read with `tsx --eval`**, loading the tag's `PRESET_LIST` in a child
  process. That executes the tag's code rather than observing what its CLI prints, which is the
  method the rest of the generated base uses.
- **An explicit `--base/--head` pair does not compare the declared level**, and says so in its last
  line. The pull-request mode does compare it. Its witness is D2's own `pnpm contract:bump`: base
  generated from `v0.18.0`, required minor, declared minor, exit 0. Whether a historical pair should
  say anything about a declared level is open.

### Boundary

One self-check pair and five mutations, of which three the operator did not re-run. Nothing here
states a rule about what a self-check must assert.

## 2026-09-24 · The first red harness verdicts in the ladder's record, and why none is a signal

### What was observed

Counted from the Workflow journals, the ladder's harness returned 64 verdicts; the preflight's first
use is among them. The first 60 all carried `passed: true`. What the ladder caught beyond `pnpm run
quality` in those 60 was `testsWeakened`, in 3 runs and 5 verdicts, each confirmed by the next rung
restoring the test. The first three `passed: false` verdicts arrived on one day, on two runs.

| Verdict | Run | What was red | Cause |
|---|---|---|---|
| 61 | 0030 C1, rung 1 | `cli-exit-codes` timed out | the environment: the characterization spawned the CLI under a fresh `HOME`, so a corepack pnpm shim downloaded pnpm again on every `pnpm --version` probe, measured at about 3.6 s a spawn |
| 63 | 0030 C2, rung 1 | `every-source-has-a-reader` named `.construct/experiments/bash-guard.mjs` | a third writer: the operator's session put an experiment input into the tree the ladder was verifying, while the ladder ran |
| 64 | 0030 C2, rung 3 | the same file | the same writer; rung 2 had stopped on a question rather than delete a file it did not write |

Verdict 62 is C2's preflight, which was green. The operator's file arrived after it.

### What it supports

**None of the three is a signal about the change the ladder was implementing.** Both implementations
passed the gate once the cause was removed. For C1, #181 fixed it, and a separate harness agent then
ran the gate green. For C2, the file was moved out of the tree, and a separate harness agent again ran
it green. Counting any of them as the ladder catching a defect would credit the ladder with a failure
of its surroundings.

**63 and 64 violate "one tree, one writer".** While a ladder runs in a working tree, nothing else
writes to that tree. The rule is not written down in this repository yet. This entry records the
first occurrence that broke it, and what the breach cost: one run ended `failed`, with a design step
and a `high` rung spent on a file outside the task.

**61 is not the same failure.** Nothing else wrote to the tree. The test harness reached the network
through a shim, and the gate became flaky under load.

### Boundary

Three verdicts on two runs are occurrences, not a rate. The count of 64 is what the journals on one
machine hold. The ledger, at L0, is not complete enough to recount them from.

## 2026-09-23 · Pre-registered predictions across an attach and detach pair

### What was done

Before code, predictions were written for two pull requests, `construct attach` and `construct detach`,
and each was labelled after its run as confirmed, refuted or not checked. No label was explained after
the fact. Seven rows under six numbers; the third prediction had two parts.

| # | Subject | Label |
|---|---|---|
| P1 | an attach interrupted between its files and its record → detach refuses and prints the block with each path marked on disk or not | confirmed; the wording was corrected by review before the run, from "prints the block, not the paths" |
| P2 | one changed carrier of N → nothing removed | confirmed |
| P3-A1 | attach writing over a tracked file → acceptance red | confirmed, by half: the target-set assertion turned red, the create-only assertion did not |
| P3-A4 | detach leaving empty directories → the round trip is red only if its snapshots list directories | confirmed |
| P4 | without "no record, no right to remove", detach removes `.construct/` wholesale | confirmed |
| P5 | the collision check after the exclude write → the refusal acceptance red only through the exclude bytes | confirmed for that acceptance; a race test outside it also turned red, on the shape of the failure, which was not predicted |
| P6 | an independently drawn rule matrix has a cell its reference does not support | labelled confirmed by review; the comparison it rests on is in neither pull request |

P1 through P4 are in the detach pull request's description. P3-A1 and P5 ran on the attach pull
request and are recorded only in the session that ran them, because that pull request's description
carries the detach text instead of its own.

### Who produced what

- **A measurement before planning** found that a carried command writes a file attach never records:
  the `/implement` skill appends to `.construct/runs.jsonl`. It drew two implications in example form
  — attach must exclude `.construct/` whole, and detach keeps the ledger and names it. Review added a
  second example from outside the measurement, `.claude/settings.local.json`, turned the second
  implication into a named rule, *no record, no right to remove*, and separated `.construct/` from the
  record as a declared zone of visibility.
- **Five brief criteria were found false and replaced aloud.** Three were written by the reviewer:
  a ladder script assumed to read files, found false by a premise check before its run; a count of 11
  that contradicted the brief's own rule that an adopted file keeps its directory, measured as 10; and
  a prediction worded against the data it described, corrected by the reviewer before the run. Two
  were written by the planning session: that git reports a directory no pattern names as ignored, and
  that removing a block is byte-exact for every prior content. Both were measured false by the
  implementer inside a run. Every one of the five came from whoever wrote the brief, which is the
  pattern recorded in the entry *Six stops on a false premise, in one night*.
- **A non-injective append** — `x`, `x\n` and `x\n\n` gave the same bytes once a block followed them
  — was found by the implementer, whose first rung stopped with the question. The architect answered
  it with a canonical form that normalised the owner's bytes; review rejected it and had the separator
  recorded instead. A further review question found that the first exact removal cut the recorded
  number of bytes without looking at them, and the final version refuses unless those bytes, and the
  separator the remainder would need, are what was recorded.

### Defect forms seen

- **One label, two questions.** In the rule matrix drawn after the attach run, *attribution* was read
  as "who produced the knowledge" in one cell and as "who authored the file" in another.
- **A label set by the implementation is a declaration, not a witness.** The `create` action on a
  planned operation is assigned by the code under test, and a mutant assigned it to its own write.

### Candidate rule, not adopted

An acceptance assertion reads a value the implementation under test did not set itself. Two instances,
both from the attach pull request: the `create` label, and the race test's first form, which asserted
how attach failed rather than what it left. It needs one from elsewhere.

**Boundary.** Two pull requests in one day, one reviewer, one planning session and one implementer
per run. Seven labels are not a calibration of how often pre-registered predictions hold, and the
five replaced criteria are not a rate of defects per brief. What the entry supports is that writing
down *which* assertion turns red before the run exposed two criteria whose first form could not tell
a wrong implementation apart.

## 2026-09-22 · A true output read for the wrong relation, and the refusal that stopped it

A false premise entered a task brief from the reviewing session, survived the owner re-running the
command it rested on, and was stopped at the implementer by a measurement.

**The premise.** `git tag | tail -3` was read as *the three newest versions*. It answers *the last
three lexicographically*, and in this repository those are `v0.8.0`, `v0.9.0`, `v0.9.1` — `v0.9.1`
sorts after `v0.16.2` because `9 > 1`.

**What followed from it**, none of which was true: that twelve releases were untagged; that the
release action does not push the tags it creates; that the header comment in
`.github/workflows/release.yml` is false where it says the v1 action pushed no tag. Two pull requests
were briefed on that reading, and a correction was drafted for a changeset stating that a missing tag
distinguishes nothing.

**The measurement that ended it.** `git tag --sort=v:refname` returns 31 tags, against 32 versions
published to the registry, with one gap: `0.1.0`. That is the version `release.yml` already documents
as published by hand, before trusted publishing could work. The document the brief called false is
the document that explains the only gap.

**What makes this specimen stronger than an ordinary failed command, said plainly.** The command
succeeded. Its exit status was zero, its output was real, and every tag it printed exists. Re-running
it reproduced the same three lines. Only the *relation* between that output and the question was
wrong. A failure would have announced itself; this did not, and the second run — by a second person,
the owner — read as confirmation rather than as a repetition of the same reading.

Two readings follow, and neither is promoted to anything.

**First: a third instance of a valid result read as evidence for a different relation.** The earlier
two are the `git ls-files` reconciliation in
[decision 0014](decisions/0014-a-check-answers-only-about-what-it-was-shown.md), and the commit
window in the entry *An acceptance played a second role at 0027's first use, and the rule describes
only the first*.

| | the question asked | what the default output answers | the flag that existed |
|---|---|---|---|
| `git ls-files` | what is tracked | what is listed | git's own ignore decision, rather than the index |
| `git A..B` | what came after in time | what is reachable by ancestry | commit time, rather than the range |
| `git tag` | the newest versions | the last lexicographically | `--sort=v:refname` |

All three are git, and in each case a flag existed that would have answered the question asked. Three
instances on one mechanism are material for this entry and are not grounds to extend anything: the
trigger for extending would be a third instance on a *different* mechanism, and this is not one.

**Second: the carrier that stopped it was neither a check nor a rule.** It was the implementer
declining to write code from a brief that did not match the tree, and measuring instead. That is the
fourth refusal to build recorded here — the first three are in the entry *Three plans that ended in
not building, each with its reason recorded* — and it is the first where the refusal kept a false
statement out of a published record rather than out of an unbuilt artifact.

**Boundary.** One premise, one night, one project, three parties. A form, not a rate. Nothing here
says how often a true output is read for the wrong relation, and nothing claims the two briefed pull
requests would have shipped: what is recorded is that the premise was false, that re-running the
command did not show it, and that a measurement did. The specimen is this repository, so
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md) costs nothing and the figures
are given rather than withheld.

## 2026-09-22 · The blind run against those cells: four instances, and no form

The run whose cells the entry *The cells of a discovery run, written before the run* fixed has
happened. The specimen is the blind copy committed at
`eebb4cce23b219c4cd2274d2ebe1d5a08b2bf729`, taken from
`76bbae4f6fa5214e88a0c38701b8c160b30bbb33` — eleven files, 681 insertions, 79 deletions — with the
transcript kept outside the tree. The copy is not pushed anywhere. The specimen is this repository,
so [decision 0019](decisions/0019-a-specimen-is-described-by-structure.md) costs nothing and the
address is given rather than withheld.

**The finding, in the words it is to be read in and no stronger:**

> In one blind discovery run the protocol produced four new instances of one structural form but did
> not state the form as a general property; the previously written carriers of that form were not
> opened.

**The four instances.** Each is something the run wrote, and each turns on whether an assertion can
be subjected to a meaningful attempt to refute it:

| plane | what the run wrote |
|---|---|
| enforcement | a new open question — `pnpm composition:check` validates the models that exist and asks nothing about a flow that has none, so a command could ship unmodelled and no check would notice |
| enforcement | a new hypothesis — every rendered artifact has a checker that fails when it is stale, rather than a convention to re-render |
| verification | nine of ten discovery markers carry `authoredBy` `"unknown"` and `sha` `null`, reported as a provenance problem: what the recorded sha exists to detect cannot be detected where there is no sha |
| enforcement | `src/failure.ts` imports `src/ui` with no entry in `ALLOWED_INTERNAL_IMPORTS`, so the boundary the `dependency-policy` marker describes was, for that file, unenforced |

**Which cell this is.** No hypothesis stated the form as a general property, and no carrier of it was
opened: the lower-left cell of the table those cells fixed, which reads as a statement about the
prescribed surface and not about the reader. **The cells were binary on whether a hypothesis matching
the form appeared, and had nowhere to put four instances written without the generalisation.** That
is a property of how the cells were drawn, recorded because the cells were fixed in advance precisely
so that the reading could not be adjusted afterwards, and adjusting them now would be the same move.

**No mechanism is offered here for why the form was not stated.** That the protocol does not ask for
generalisation, and every neighbour of that sentence, is a further layer; this run does not settle
any of it and nothing here should be read as evidence for one of them over another.

**The evidence for *carriers not opened*.**
[Decision 0027](decisions/0027-an-acceptance-is-red-before-the-implementation-exists.md) appears
nowhere in the run's list of files opened. This file and [epistemic-rules.md](epistemic-rules.md)
appear only as lines in grep output; neither was opened.

**A second run is excluded from the evidence rather than counted against it.** A different tool was
given the same task, opened five files, wrote no hypothesis and did not execute the protocol. That is
an invalid run and not a negative result: nothing can be concluded from it about what the protocol
surfaces, because the protocol was not run.

**The provenance defect is left unrepaired on purpose.** Nine of ten markers in this repository's own
`construct.json` still carry `authoredBy` `"unknown"` and `sha` `null`. That state is part of what
produced this result — it is one of the four instances — and repairing it before this record existed
would have changed the specimen. **The repair is the next task and is not part of this one.**

**Three boundaries, each of which bounds the finding rather than softening it.** The list of files
opened is the agent's report about its own work, in exactly the sense
[0027](decisions/0027-an-acceptance-is-red-before-the-implementation-exists.md) calls an opinion
rather than evidence a second party can read; the transcript is the second-party artifact, and it is
what settles any disagreement with the list. This is one run. And the run's agent is of the same
lineage as the one with which the form was first stated, so *independent* here is bounded by that
lineage and not by nothing.

**Boundary.** One run, one specimen, one protocol, one lineage. A form, not a rate: nothing here
counts how often the protocol produces instances without their generalisation, and four instances in
one run is not a frequency. Nothing in this entry is promoted to a decision or a rule.

## 2026-09-22 · The cells of a discovery run, written before the run

A copy of this repository was taken at `76bbae4f6fa5214e88a0c38701b8c160b30bbb33` — the head of
`fix/absent-is-derived-not-guessed`, not of `main` — before this entry existed, to ask whether the
discovery protocol surfaces a form that is stated nowhere in the tree. The run has not happened. What
is recorded here is what each outcome would mean and what the run does not measure, written first so
that the reading cannot be fitted to the result once the result is in hand.

**The form**, in the words it was given outside the repository:

> An assertion that cannot be subjected to a meaningful attempt to refute it is a declaration, not a
> check.

**The tree carries an instance of it, not the form.**
[Decision 0027](decisions/0027-an-acceptance-is-red-before-the-implementation-exists.md) states the
property of one thing, an acceptance criterion: *a criterion that cannot be shown failing is a
statement of intent, however specific its wording*. Searching for that sentence before the copy was
taken found it in four files — 0027, `docs/guide/the-cycle.md` §3, `docs/release-notes/index.md` and
`CHANGELOG.md` — the last three being renderings of 0027 rather than independent statements. Two
further files carry an adjacent generalisation of the same property under another name:
[decision 0024](decisions/0024-an-absent-claim-is-derived-not-recorded.md) refuses a stored absence
because it would be the one entry in the model *nothing could refute*, and the entry *A rule with no
independently checkable carrier is carried by memory* states the carrier test for a rule. The form
above appears in none of the six, and appears in this repository for the first time in this entry —
which is why the copy was taken at a commit that predates it.

**The prescribed reading surface names none of those six files.**
`.claude/commands/construct-discover.md` sends the agent to `construct.json`, `package.json`, the
tree two levels deep, the entry points, the contract, the `*.config.ts` files, `AGENTS.md`,
`architecture/security-invariants.md` and `architecture/composition`. Neither
`architecture/decisions/` nor this file is named anywhere in it.

**The four cells.** The run has two readings: whether discovery writes a hypothesis matching the
form, and what the list of files it actually opened contains.

| | no carrier of the instance opened | a carrier opened |
|---|---|---|
| **a hypothesis matching the form** | the strongest positive the run can give: the prescribed surface was enough to reach the form from the repository's structure, and the discovery is independent | a restatement: the agent met the instance and generalised it, which says nothing about the prescribed surface, because the surface is not where it was met |
| **no such hypothesis** | a reading about the surface and not about the reader: the protocol never sent the agent to the files where the instance lives | the sharpest negative the run can give: the instance was in hand and was not lifted into its form |

Two things follow from that table, and both were got wrong once on the way to writing it, which is
why each is said here in its own sentence rather than left to be inferred from the cells.

**A protocol that does not prescribe a file is not an agent failing to read it.** The lower-left cell
is the one that invites the mistake: nothing written, nothing read, and the easy reading is that the
agent did not look. It did not look because it was not sent, and a run that recorded only the absence
could not tell the two apart. That is the whole reason the run asks for the list of files actually
opened — an ask the protocol's own report step does not make, and an addition to it for this run
rather than a change to the protocol.

**A hypothesis matching the form is attributable to independent discovery only on that list.** The
attribution holds if the list shows every carrier unread — 0027 and its three renderings, 0024, and
this file. The pair that matters most is 0027 and this file, and the other four were added by
searching for the sentence rather than by recalling where it had been written; a list that showed
`docs/guide/the-cycle.md` opened would settle the question as completely as one showing 0027 opened,
and the first draft of this entry did not name it.

**What the run does not measure.** Whether the form is true or useful: the run asks only whether the
protocol's surface reaches it. Whether the protocol *should* prescribe `architecture/decisions/` or
this file — that question is raised by a positive in the upper-right cell and by a negative in the
lower-right, and is not answered by either. How often any of this happens: one copy, one protocol,
one agent, one run. And the read list has the standing 0027 gives an implementer's answer about their
own work — it is a report, not evidence a second party can check, unless the run's transcript is kept
and read against it; where the two disagree, the transcript is the reading.

**Boundary.** No data. This is a record of an experiment not yet run, and nothing in it is a decision
or a rule: the cells are written down so that the run cannot be read generously afterwards. The
specimen is this repository, so [decision 0019](decisions/0019-a-specimen-is-described-by-structure.md)
costs nothing here — there is no address to withhold — and it is said rather than left unstated.

## 2026-09-21 · The `add` population, named before anything is done about it

A live run against an adopted single-package frontend repository left two construct-written artifacts
that do not fit it: a `"preview"` script naming a dev server the repository does not use, and a
`tsconfig.base.json` that nothing extends, because the repository's own `tsconfig.json` extends a
framework preset. Neither is a conflict — the construct added them and the owner never touched them,
so they read as ours and sit there inert or wrong.

This entry names the population rather than repairing it. Nothing in `src/sync/`, `src/materialize/`
or `templates/` changes here.

**What `add` actually tests.** `classifyPath` reaches `add` on exactly one condition: the path is
absent from the tree, the manifest records no sha for it, and the template groups produced it. There
is no notion of applicability anywhere in the classification — "the preset produces it and the tree
lacks it" is the whole of the test.

**The two conditionalities that do exist**, both in `planMaterialize` and neither reached by `sync`:
a mount marked `onlyWhenEmpty` is skipped against a non-empty tree, and the groups so skipped are
reported as `omittedGroups`. That is the only machinery in the tool for deciding a path does not
apply, and it keys on the tree being empty, never on what the tree is.

**The population, partitioned.** Across the four available presets, `planMaterialize` produces 88
distinct paths. 37 of them are reached only in an empty directory, by the mechanism above. The
remaining 51 are written into any tree that adopts the construct, and they fall into four kinds:

`construct-subject` — the construct's own material, which cannot misfit because the construct is what
it describes: `.claude/agents/architect.md`, `.claude/agents/harness.md`,
`.claude/agents/implementer.md`, `.claude/commands/construct-discover.md`, `.claude/commands/plan.md`,
`.claude/rules/conventions.md`, `.claude/rules/css.md`, `.claude/rules/secrets.md`,
`.claude/rules/tests.md`, `.claude/skills/implement/SKILL.md`, `.github/workflows/security.yml`,
`.gitignore`, `.gitleaks.toml`, `AGENTS.md`, `CLAUDE.md`, `architecture/checklists.md`,
`architecture/decisions/README.md`, `architecture/principles.md`,
`architecture/security-invariants.md`, `scripts/construct/check-acceptance.mjs`,
`scripts/construct/implement.workflow.mjs`.

`harness-adoption` — presumes the repository runs the construct's harness, and is inert or wrong
where it runs another: `.editorconfig`, `.github/workflows/ci.yml`, `.nvmrc`,
`.vscode/settings.json`, `eslint.config.mjs`, `package.json`, `pnpm-workspace.yaml`,
`scripts/composition/check.ts`, `scripts/composition/files.ts`, `scripts/composition/model.ts`,
`scripts/composition/render.ts`, `scripts/composition/sync-docs.ts`,
`scripts/tests/composition/files.test.ts`, `scripts/tests/composition/model.test.ts`,
`scripts/tests/composition/render.test.ts`, `tsconfig.base.json`, `tsconfig.json`,
`vitest.config.ts`.

`layout-or-stack-assumed` — asserts a directory layout or build shape the repository may not have:
`packages/shared/package.json`, `packages/shared/src/index.ts`,
`packages/shared/tsconfig.build.json`, `packages/shared/tsconfig.json`, `tsconfig.build.json`.

`contract-bound` — reached only where the chosen preset materializes an HTTP contract:
`.github/workflows/api-contract.yml`, `contracts/api/openapi.yaml`,
`packages/shared/src/api/openapi.ts`, `redocly.yaml`, `scripts/contracts/types.mjs`,
`scripts/tests/contracts/security.test.ts`, `src/contracts/openapi.ts`.

**Where the two observed misfits fall, and what that shows.** `tsconfig.base.json` is
`harness-adoption`: it is correct wherever the repository's own `tsconfig.json` extends it, and inert
wherever that file extends something else. The `"preview"` script is not a path at all — it is a key
inside `package.json`, which `sync` classifies through `merge-json`, so the misfit arrives as an
added key on a path classified `update` rather than as an `add`. **The applicability question has two
granularities, and only one of them is a file.**

Of the five kinds, two are already conditional — `sample-only` on the tree being empty,
`contract-bound` on the preset chosen — and one, `construct-subject`, cannot misfit. So the
population where a misfit can occur is exactly `harness-adoption` and `layout-or-stack-assumed`, 23
paths plus the keys merged into `package.json`. Each observed misfit fell in a different one of the
two, which is why one of them looked like a frontend problem and the other like a TypeScript problem.

**What it would take for `add` to decide otherwise.** Nothing in the current model can express it: a
fact about the tree would have to be available at classification time, and `classifyPath` is given
only the target, the recorded sha, the present content and the produced content. Whether that fact
should come from `detect` — which reports facts and never interprets
([decision 0015](decisions/0015-interpretation-stays-with-the-agent.md)) — or from the preset
declaring a precondition per path, is not settled here and is the question this entry exists to hand
over.

**Boundary.** Two misfits, one repository, one preset. The partition above is complete over what the
presets produce today and is checked by `tests/add-population.test.ts` in both directions; it says
nothing about how often a misfit occurs, and nothing here has been observed for the monorepo,
backend or library presets.

## 2026-09-22 · An acceptance played a second role at 0027's first use, and the rule describes only the first

[Decision 0027](decisions/0027-an-acceptance-is-red-before-the-implementation-exists.md) requires an
acceptance to be **red on the current tree before the implementation exists**. Its first application
carried two axes, and only one of them behaved that way.

**The window, so the word *first* carries what would falsify it.** 0027 merged as `71ff5d2`. The only
commit between that and the branch of its first application is `c5373a1`, the automated
version-packages commit that released v0.14.1 and performs no task. Every commit in the repository
made after 0027, taken by commit time rather than by ancestry, is those three.

**What happened.** The task was
[decision 0028](decisions/0028-a-model-ahead-of-the-reader-is-a-state.md), naming a record from a
later build as a state. Axis one — the state is distinguishable from a corrupt or invalid model — was
red on the tree, as 0027 requires. Axis two was green before the change **and could not have been
red**: the defect it describes does not exist there, because the reader already threw rather than
collapsing an unreadable record into absence. It becomes red only when a specifically named wrong
implementation is introduced and the guard is run against it, which is what was done.

Stated in the form the record uses:

> Axis 2 is a regression guard against collapsing an unreadable record into absence; the current
> implementation already preserves that distinction.

**So an acceptance has two legitimate roles, and 0027's test describes one of them:**

| the role | when it is red |
|---|---|
| detect an existing defect | red on the current tree |
| forbid a named wrong fix | never red on the current tree — red only against the named wrong implementation |

**The second role needs a clause the first does not, or it is satisfiable by construction.** Any guard
can be made red against a sufficiently absurd implementation, and doing so proves nothing about what
the guard holds. So: **the named wrong implementation must be one a reasonable implementer would
actually reach for.**

**The plausibility evidence for this case is in the record rather than argued from taste.** The
forbidden implementation — catching the version error in the reader and returning `null` — is what
the task brief itself described as the current state, and the reviewing session predicted axis two
would be red precisely because it believed that collapse already existed. A wrong fix that was
reached for while the task was being written is as plausible as one gets.

**How the gap was found is why this is an occurrence and not a note about improving a rule.** It came
out of 0027's own procedure at its first use: the forbidden path was run and the actual outcome read,
rather than the axis being reasoned about. Reasoning about it produced the opposite answer twice —
once in the brief and once in the implementer's own expectation — and the run settled it.

**This does not extend 0027.** The question it raises — whether *red on the current tree* should
become *red on the current tree, or against a plausible named wrong implementation* — is named here
and left open. One application, one gap; extending a rule on a single instance is what this
repository declined four times the day before, recorded in the entry *Three plans that ended in not
building*, and the basis here is no stronger. **The trigger** is a second acceptance that turns out to
be a guard against a wrong fix, in a task unrelated to this one.

**Boundary.** One application of one rule, one gap, one project. A form, not a rate, and not evidence
about how often acceptances fall into the second role. The specimen is this repository, so
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md) costs nothing here — there is
no address to withhold — and it is said rather than left unstated.

## 2026-09-22 · A rule with no independently checkable carrier is carried by memory

Two rules in this repository were stated clearly, meant seriously, and observed by whoever happened
to remember them. Both are already recorded; this entry is about what they have in common rather
than about either.

**The documentation claim.** The entry *A claim with a complete lifespan* records a sentence that stood through ten minor versions
and twenty-one releases while being wider than what had been measured. Its record layer had a
carrier and that carrier held; the claim the sentence made about the rendered document had none. No
check could have gone red, so nothing did.

**The ladder.** How much reasoning a task gets, and when to escalate, lives in prose in a skill and a
guide. The only artifact a run leaves is a ledger line, which
[decision 0003](decisions/0003-run-ledger-stops-at-l0.md) places at L0 by construction, and which
the measurement under *Half the ladder runs were never recorded* found written for 29 of 65 runs — evenly across sessions,
including the session of the operator writing that entry, who was watching for it.

**What they share is not that they were broken. It is that breaking them produces nothing.** A rule
observed by memory and a rule observed perfectly are indistinguishable from outside, because neither
emits anything. The absence of complaints about a rule is evidence about the reporting, not about the
rule.

So the form:

> **A rule whose observance cannot be checked by anyone other than the person observing it is carried
> by memory, and memory is not a carrier.** The test is mechanical: name the artifact that would
> exist if the rule were broken, and name who could read it without taking the actor's word.

**This rule was considered for promotion to a numbered rule in
[epistemic-rules.md](epistemic-rules.md) and was not promoted, because it fails its own requirement.**
Nothing would exist if it were broken. There is no artifact that reads *this rule was stated with no
carrier*, and no reviewer who could find one without going looking. Promoting it would have put into
the numbered list the only member of that list which cannot be observed to fail — and the numbered
rules are cited by decisions precisely because a citation can be checked.

It could have gone the other way, and that is what makes the refusal a finding rather than a
flourish: had a carrier existed — a check over records that names a normative sentence with nothing
behind it — the rule would have been promoted and this paragraph would not exist.

**Boundary.** Two instances, one project, one span of work. A form, not a rate. Nothing here counts
how many rules in this repository lack carriers; no survey was run, and the two above were found by
tripping over them rather than by looking. The specimen is this repository, so
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md) costs nothing and is said
rather than left unstated.

## 2026-09-22 · Three plans that ended in not building, each with its reason recorded

Planning in this repository has ended three times in a decision not to build the thing that was
planned. Each is recorded where it belongs; what is recorded here is that they are one shape.

**The skill.** The entry *The discovery plan skill was not built, and the empty plan is why*: the plan was written by hand first,
came out empty, and the emptiness was the result rather than a missing one — the skill as scoped
would have been a second rendering of what the report already carries.

**The trace.** [Decision 0020](decisions/0020-a-claim-is-written-only-where-its-evidence-holds.md)
left an open question about how `doctor` could say why the set of claims is short, and treated the
model keeping no trace of an unmade claim as the obstacle.
[Decision 0024](decisions/0024-an-absent-claim-is-derived-not-recorded.md) answered it by refusing to
record one: the absence is recomputed from `construct.json` on every read, and a stored absence would
have gone stale silently where a derivation stops being reported the moment it stops being true.

**The rule not promoted.** The entry *A rule with no independently checkable carrier is carried by memory* proposes a rule and declines to promote it, on the
standard that entry itself proposes. The self-reference is the point rather than an awkwardness to
smooth over: a rule about carriers was refused a number because it has no carrier. It could have gone
the other way — had one existed, there would be two instances here and not three.

**What the three have in common**, which is the whole of this entry:

| | the plan | why it was not built |
|---|---|---|
| the skill | a renderer over the model | the report already carries the reading |
| the trace | a recorded absence | a stored absence goes stale where a derivation does not |
| the rule | a numbered epistemic rule | it does not satisfy its own requirement |

None was dropped quietly. Each reason is specific to the thing rather than a general appeal to scope,
each is written where a later reader will meet it before re-opening the question, and in each case
what was learned went into a record instead of into the artifact that was not built. That last part
is what distinguishes this from deciding against work: the output was a record, so the plan produced
something either way.

**Boundary.** Three, one project, one span. A form, not a rate. Nothing here says how often planning
ends this way, and nothing claims these three would have been bad builds — only that each was decided
against for a reason that was written down and can be argued with.

## 2026-09-22 · Six stops on a false premise, in one night

Six times in one session, work stopped because a stated premise turned out to be false when measured.
They are recorded here rather than inside the decision written from them, so that the occurrences
stay citable on their own and the decision does not carry its own evidential base.

| | the premise, as stated | what measurement showed |
|---|---|---|
| 1 | a pull request was merged and a branch could be cut from it | `origin/main` did not contain it; the pull request read `merged: false`, and it merged some forty minutes later |
| 2 | a file's modification time was "approximately" a recorded timestamp | the recorded time was 54 seconds earlier; the approximation was replaced by ten recorded hashes, which depend on no timing at all |
| 3 | a defect had been invisible in the output | the output had named the change, with both values in full, since the release that introduced the record |
| 4 | an acceptance comparing two later runs would guard two known defects | it passed under both: each defect settles on a wrong value by the second run, so a later comparison sees a stable system |
| 5 | new keys legitimately appear between the first and second run of one preset | they do not — the sample directories are exactly the ones the first run creates |
| 6 | a derivation was strictly stronger than the record it replaced | it was, until the same change made the record able to answer; the argument outlived its own ground by one commit |

**Five of the six were the reviewing session's premise; the sixth was the implementing session's.**
That distribution is worth stating because it is not the flattering one for either party, and because
the mechanism does not depend on it.

**The condition that makes it work, and the part easiest to lose.** In all six the party who wrote
the criterion was not the party who measured it. The criterion arrived as a statement about the
system, and the session holding the code checked it before building to it. A stage where the same
party writes and tests its own acceptance is a much weaker thing, because the premise and the
measurement then come from the same reading, and nothing new is consulted.

**Boundary.** Six stops, one operator, one project, one reviewing session, one night. A form, not a
rate. It does not say how often such a stage stops anything. It does not establish that a session
without it would have shipped the falsified premises — five of the six would have produced a green
test or a correct-looking record either way, which is the reason they were worth stopping on, not
evidence about what would have happened. What it records is that in six observed cases the premise
was false and the measurement is what showed it. The specimen throughout is this repository, so
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md) costs nothing here.

## 2026-09-22 · A claim with a complete lifespan: the record was made additive, the document was not

Every other entry here records something observed once. This one records a claim through its whole
life — the date it was made, the evidence it was made on, the layer that evidence covered, the layer
the sentence claimed, the date it was falsified and what falsified it. That completeness is the
reason to keep it. The repository is this one, so it is named; the repository the falsification came
from is described by structure alone, under
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md).

**The claim, and the evidence under it.**
[Decision 0013](decisions/0013-a-second-init-adds-to-the-record.md) was accepted on 2026-09-17. A
second `init` had been replacing `construct.json`'s `files` branch with only the paths that run
wrote, so every path an earlier run wrote and this one skipped left the record silently; measured on
a scratch tree carrying 43 recorded paths, the next `sync` read 4 `keep` and 39 `conflict` with
nothing in the tree changed. The decision made the record additive and named `variants` among the
branches that must survive a re-run. A second `init` was a known hazard with a measurement behind it,
not something nobody had looked at.

**The later defect rode in on the decision's own sentence.** `files` and `variants` "carry every
entry the previous manifest recorded, then the entries this run wrote". `AGENTS.md` is an
`append-block` target, so every run writes it, so the second clause always won: `buildManifest`
spreads the variants of this run's written ops over the carried entries, and the variant in each of
those ops had been computed a moment earlier from whether the file was on disk — which, from the
second run onward, it always is. The record held the right answer and handed it to the caller that
computed the wrong one, on every run, for every target that ships in more than one form.

**What the tests covered was the record's self-consistency, not its stability.**
`tests/init-record.test.ts` did assert that `variants` carried over — inside a guard excluding every
path the run wrote, which is every `append-block` target, which is exactly the set with a second form
to carry. Its hash assertion compared the recorded sha against the bytes now on disk, which holds
whatever was written. `tests/init.test.ts` carried a case named *is idempotent: a second run keeps the
discovered content*, asserting four things: no reported conflicts, the discovery body still present,
one `construct:begin` in the file, and the marker not reported missing. The replacement satisfies all
four — the discovery bodies are carried across by design, and what replaces the block is a
well-formed block. Running `init` twice and comparing what it rendered was done by no test in this
repository until `tests/init-convergence.test.ts`.

**The sentence that was wider than its evidence.** `docs/guide/upgrading.md` recounts the 43-path
measurement and concludes: "That is fixed: the record is additive now, and a re-`init` carries
forward every line it did not write." The second clause is true and was tested. The first is wider
than anything that had been measured — it reads as *the second `init` is fixed*, when what was fixed
was its record layer. It shipped in v0.3.0 and stood through v0.12.2: ten minor versions,
twenty-one releases, four days.

**What falsified it.** A pnpm monorepo that had adopted the construct, materialized by 0.1.1 and
since diverged, taken on 2026-09-21 through `sync`, `sync --apply`, its own harness, `init` and
`doctor` on 0.12.2. The second `init` rewrote `AGENTS.md` from the form the construct writes when it
creates the file into the form meant for a file that was already there, and the baseline command
block went with it. Attribution was settled by reconstructing the recorded hashes rather than by
argument: what `sync --apply` recorded for that path is exactly the owned sha of the default form,
the file as found is exactly the owned sha of the existing form, and `variants` — written only by
`buildManifest`, and only by `init` — said `existing`.

**Where the sentence stands now.** The form is read from `variants` rather than from file existence,
and the convergence test compares every file `init` writes, byte for byte, between runs. The
sentence in `upgrading.md` is closer to true than when it was written, by work that had nothing to do
with it, and it is still wider than the evidence: a second `init` on the monorepo preset re-derives
`workspacePackages` and `allowedWorkspaceImports` from the packages the first run created, recording
a dependency policy the file on disk does not carry, after which `sync` classifies
`eslint.config.mjs` as `update` and `sync --apply` writes the looser policy over the stricter one.
That one is open.

**The boundary.** One claim, one repository, one falsification. Nothing here is a rate, and nothing
here says how often a sentence outruns its evidence. What it supports is narrower: the distance
between the layer an evidence covers and the layer a sentence claims can be measured after the fact,
and in this instance it was four days, ten minor versions and one guard clause.

## 2026-09-21 · The discovery plan skill was not built, and the empty plan is why

A skill was scoped to turn what the model holds open into a proposed plan. Written out by hand first,
against this repository's own model at `18c435c`, the plan came out **empty**, and the emptiness is
the result rather than a missing one.

**The measurement.** The model carries seven hypotheses, every one `authoredBy: discovery`, every one
recording `baseSha` `906f554`, every one `evidenceClean: true`. All twenty-eight facts were
re-evaluated against the tree and all twenty-eight hold. Under the three kinds of decay the skill was
scoped to name, the plan has zero items in each:

| Decay the skill would report | Items |
|---|---|
| A fact that stopped holding | 0 |
| A hypothesis recorded from a base it never read | 0 |
| A question whose carrier stopped holding | 0 |

**Why the emptiness is evidence and not an absent result.** Had anything decayed, `doctor` would
already say so. A hypothesis whose facts stop holding reads `unsupported` under STANDING HYPOTHESES,
derived by the same `deriveModelState` through the same projection the skill would have called. So
the skill as scoped is **a second rendering of knowledge the report already carries**, and building it
would have produced another renderer named as a capability.

**The procedure, recorded because this is its second use today.** In both cases a plan written by
hand, before any code, decided whether the work should exist. The first found that the *input* had no
honest carrier: three of four open questions asserted something false and nothing could re-check them,
which sent that change to repairing the questions and running discovery instead. The second found that
the *output* would be duplicative. It is a check of necessity, not a preparation for implementation,
and the distinction matters: preparation assumes the thing gets built and asks how, while this asks
whether, and twice answered differently from the brief that proposed it.

**Boundary.** Two uses in one day is a form, not a rate. Nothing here says a hand-written plan would
catch anything on a third feature, only that on these two it changed the decision before any code was
written. The specimen is this repository itself, so
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md) costs nothing here — there is
no address to withhold — and it is said rather than left unstated.

## 2026-09-21 · A command that did not run, read as a measurement that did

Two cases on one machine in one day, on which the same `xcrun` shim happened to be broken: a scan
reported pull request bodies clean from a run in which `gh` was never found, and an `evidenceClean`
computation would have written `true` for five hypotheses from a `git` that never executed —
`returncode 1`, empty stdout, the failure on stderr where nothing was reading.

**The shape, which is what this records:**

    a command fails  →  an empty or zero result  →  read as a successful measurement

It is not a property of `git` or of `gh`. Either would have served, and any tool invoked the same way
would have produced the same reading. That is a form, not a rate, and nothing here says how often it
happens.

**Nor is it a property of the shim.** The same reading arose in that session from a second, unrelated
cause: a 403 from the proxy on the GitHub API. Zero matches distinguishes neither "the tool was not
found" nor "the API refused" — two sufficient causes, one empty result, and the result names neither.
This is reported by the reviewing session and not verified here; its weight is that the form does not
depend on the shim. Without it this entry would read as one machine's broken toolchain, which is the
narrowest thing it could be taken for and the least useful.

**Catching it was luck, and the record would be a success story without this paragraph.** The failed
measurement was visible only because an unrelated expectation happened to contradict it: the working
tree was dirty at that moment, so `evidenceClean: true` was obviously wrong on its face. Had the tree
been clean, the failed measurement and the correct answer would have coincided exactly, and five
hypotheses would carry a value nothing in them records as unmeasured. **The defect is invisible
precisely when it is harmless and visible only by accident** — so an accident is what caught it, and
nobody should plan on one.

**Why no test catches it.** A test asserts the shape of a value, and the value has the right shape: an
empty string is what a clean tree returns. What catches it is an expectation named *before* the
reading — say what the result must contain, then read, and a command that did not run fails the
comparison instead of supplying a plausible answer.

**The requirement this leaves:** a result is not a measurement merely because it has the expected
shape; the measurement must also evidence that it was performed.

**What this does not ask for.** Not a check that `git` or `gh` is present: that repairs one tool and
leaves the shape standing behind it. Not a third value for `evidenceClean`, which would be a schema
change and a `MODEL_VERSION` bump to represent a state that should forbid the write rather than be
written. And no change to anything shipped in this pass. The remedy named here is procedural: where a
hypothesis depends on a measurement, a measurement that cannot show it ran means **no hypothesis is
written at all**.

**Boundary, and where it sits.** The `gh` case is recorded as reported by the reviewing session;
what the session writing this verified first-hand is the shim breaking `gh` during a pull request
creation, and the `git` case in full. This belongs beside two readings already here —
[rule 2](epistemic-rules.md), that
`unknown` is not absence, and the finding above that an empty result never names its cause. It is the
same family one level further down: not a reading whose cause is unnamed, but a reading that never
happened, wearing the shape of one that did.

## 2026-09-21 · `testsWeakened` fired on a second class of change

The ladder's `testsWeakened` guard rejected a change in which tests were deleted **together with the
feature and the modules they covered** — doctor's `hook` and `red-gate` verdicts and their check
files, removed deliberately in v5.1 task 3.

The gate detected the deletion correctly and could not determine whether it was legitimate feature
removal or deletion intended to weaken coverage. A human established legitimacy by matching each
removed test to a removed module or fixture; the surviving `runner.ts` coverage was unchanged, and
the test count rose from 566 to 568.

**Boundary.** Two classes have now been observed: a narrowed assertion inside a live implementation
change, and deletion alongside the code under test. Deletion cases may need human adjudication,
because legitimacy depends on whether the module under test also went. Nothing here says how often
either class occurs.

Related: the open question on enforcement capability in [AGENTS.md](../AGENTS.md).

## 2026-09-21 · The architect returned nothing, again

v5.1 task 3 escalated to `xhigh`. The architect failed structured-output validation five consecutive
times and returned nothing, so no implementer ran from a spec.

This is another occurrence of the failure mode
[decision 0008](decisions/0008-a-retry-buys-a-new-exploration.md) already describes, and it changes
nothing about that decision.

**Boundary.** Recorded as an occurrence only. No frequency and no cause is claimed from it.

## 2026-09-21 · Templates inspected before 0.5.0, nothing found

Before publishing 0.5.0 — the release that removes two `doctor` verdicts, renames a third and moves
two more — `templates/` was searched for anything that would become false the moment a new
repository was materialized from it. A stale page in the docs misleads one reader; a stale template
ships the falsehood into every repository the tool creates, and no later edit to the website
catches up with it.

**Inspected:** every occurrence of `doctor` under `templates/`, and every occurrence of the verdict
identifiers `red-gate`, `hook`, `lint-policy`, `construct-tests`, and of `weakestLink` and
`harnessProblems`.

**Found:** nothing. The three templates that mention `doctor` —
`templates/ai/claude/CLAUDE.md.eta`, its `.existing.eta` variant, and
`templates/ai/shared/_claude/commands/construct-discover.md` — describe it only as checking that the
baseline and the discovery markers are intact, which this release does not change. No template names
a verdict, a level or the shape of the output.

**Boundary.** This was a search for identifiers and for the word `doctor`. It is not evidence that
no template prose is stale for some other reason, and it is a search rather than a mechanism: the
task that ties every identifier named in docs and templates to one that exists in code is deferred
to after the release, and until it lands the next removed verdict will need this search repeating by
hand.

## 2026-09-21 · `doctor` 0.5.0 run against a diverged construct repository

Run against a single-package repository this tool materialized itself, read at a single commit, which
this record does not name.

**What the tree is, stated precisely.** It was materialized by `construct init` at 0.1.1 and has
since diverged from the templates on 16 paths. It is a **diverged construct repository, not an
adopted one.** [Decision 0017](decisions/0017-v5-adds-no-new-way-of-knowing.md) asks the projection
step to be accepted against a repository the construct never materialized, and this tree does not answer that.
**That half of the criterion remains open.**

**What `doctor` 0.5.0 returned, before `sync --apply`:**

    ok: true · checks: [] · youAreHere: { at: "no-model" } · unreadableFiles: []
    harnessProblems: [] · uncollectedTests: [] · missingFiles: []
    modifiedFiles: 19 · provenance: 10 markers, all authorship "unknown"
    versionGap: materializedBy 0.1.1, readBy 0.5.0, pending 9

**After `sync --apply`:** `modifiedFiles` 26, `pending` 0, everything else unchanged.

**What the run was worth.** The seven newly-modified files exposed the baseline defect fixed in
[#71](https://github.com/E1i/mikoshi-construct/pull/71): `doctor` compared every path against the
frozen `init` record and ignored the sync record. No fixture had caught it because no fixture ran
`sync --apply` before `doctor`.

The manifest at that commit shows the defect had a second, quieter half. Its sync record names nine
paths, of which eight also appear in the init record and one —
`architecture/decisions/README.md` — appears **only** in the sync record. The eight were compared
against stale hashes, which is where the false entries came from; the ninth was never examined at
all, so it could have been missing or altered without `doctor` saying anything. The noisy half was
reported and the silent half was not, which is the usual order. Seven of the eight appeared as newly
modified, consistent with one of them having already been among the nineteen; that last step is
arithmetic on the reported counts rather than something this record verified directly.

**Two things this run does not establish.**

- **No adopted repository was inspected.** See above; the criterion is open.
- **`uncollectedTests: []` says nothing about the conditional behaviour.** The construct wrote the
  runner config here, so an empty result means only that no recorded test is uncollected. Staying
  silent where the construct did *not* write the runner config remains unverified outside fixtures —
  more so now, since #71 changed how that function locates the config.

## 2026-09-21 · A local npm cache answered with a version that was no longer current

While confirming that 0.5.0 had published, `npm view mikoshi-construct version` returned `0.4.0`
repeatedly, minutes after the publish step had logged `Successfully published`. The registry was not
stale; a local cache was. `--prefer-online` returned `0.5.0`, and `pnpm release:verify` confirmed the
package was installable.

The shape is the one this project keeps meeting: **an answer that is green, or old, for a different
reason than the one assumed**, and indistinguishable from the real answer without a flag that changes
where it is read from. The same shape as the earlier run whose failure turned out to be `EADDRINUSE`
rather than the defect under test.

**Boundary.** One occurrence. It says nothing about how often the cache is stale, only that the
stale answer is not distinguishable from a current one by reading it.

## 2026-09-21 · `continue-on-error` searched for across the templates, one occurrence

A job carrying `continue-on-error: true` is a check that cannot fail, and one was found shipping in
`templates/base/_github/workflows/security.yml` — the dependency audit. The obvious worry was that
whoever set it once had set it elsewhere.

**Searched:** every occurrence of `continue-on-error` under `templates/` and under `.github/`.

**Found:** exactly one, the dependency audit, in the template and in this repository's mirror of it.
A single deliberate choice rather than a habit that spread.

**Boundary.** A negative result, recorded because an unexamined tree and a clean one look identical
from outside. It covers that one string; a check disabled some other way would not appear in it.

## 2026-09-21 · Runs awaiting approval were read as a branch property, not as our own wake

Of 120 CI runs, 29 sat in `action_required`, every one on `changeset-release/main`. This was reported
as a property of that branch — something about how the version pull request is created.

It was not. The changesets action force-pushes that branch whenever the default branch moves, and a
force-push discards the approval already granted, restarting the runs. The 29 were the wake of
ordinary merges landing while a version pull request was open — **our own merges**, each orphaning
the run before it.

The general form is worth more than the instance: **where two explanations fit the same data equally
well, the one that does not involve the observer is the one chosen by default.** The data had been
measured correctly and attributed to the environment, and the alternative was never considered
because it required noticing our own contribution to it.

## 2026-09-21 · Two adopted repositories inspected, and the first broken chain

0017 asks the projection step to be accepted against a repository the construct never materialized.
Two were used, both copies so nothing was written to the originals, both adopted by running `init` into them and
then `doctor`.

**Specimen A — a repository built to conventions much like the construct's.** 582 commits, pnpm, its
own `vitest.config.ts`, its own workflows including `ci.yml` and `security.yml`. `init` wrote 19 files
and skipped every existing config. `doctor` then reported `ok: true`, no missing, modified or
unreadable files, and **all five claims held**.

That was not the prediction. It held because the repository already satisfied the preset's claims —
it has gitleaks in a security workflow, a `ci.yml` running the harness command, oasdiff on the API
contract — having been built by the same author to the same standards.

**This is a correction to the criterion, not a caveat on the result.** 0017 asked for a repository
the construct never materialized and silently assumed such a tree would be foreign in its
conventions. Specimen A shows those are different properties: the construct never made it, and five
claims hold anyway — not because the construct is universal, but because the repository was written
by someone who thinks the way it does. What tests generality is **written to other conventions**, not
**not materialized by us**, and the criterion should be read that way from here.

**Specimen B — a repository built to other conventions.** jest rather than vitest, npm rather than
pnpm, its own CI. `init` wrote 40 files. `doctor` reported **two claims `unsupported`**, both standing
on the same fact:

    ci             L3  unsupported  expects … — no longer matching: .github/workflows/ci.yml
    harness-steps  L3  unsupported  expects … — no longer matching: .github/workflows/ci.yml
    You are here: every-change-passes-the-harness — enforcement unsupported:
                  .github/workflows/ci.yml no longer matches

The repository has a `ci.yml`; it does not run `pnpm run quality`, so the fact honestly does not hold.
**This is the first time on any real repository that a chain has stopped in the middle**, and the
first time `YOU ARE HERE` has shown the thing it was written for.

### What this discharges, and what it does not

**0017's criterion for the projection step is met.** Both trees were ones the construct never materialized.

**The `uncollectedTests` conditional is verified, on a third specimen, with its counterfactual.**
Getting there took retracting a wrong conclusion, which is the more useful half of this entry.

On specimen A the list was `[]` and the runner config was indeed absent from the manifest — but the
manifest also recorded **zero** test files, because the harness tests already existed there and were
skipped. Two sufficient causes, one empty list. From that and specimen B I concluded that *no*
adopted repository could exercise the branch. That was a negative universal drawn from two samples,
and it was wrong.

The branch needs a repository that **has** a runner config the construct would otherwise write, so
the construct's is skipped and unrecorded, and **lacks** the harness tests, so those are written and
recorded. Specimen C — vitest with its own config, no `scripts/tests/` — is exactly that: no recorded
runner config, four recorded test files.

There the empty list still had a second cause, because that owner's config declared no literal
`include`. Only after giving it one that excludes the construct's tests did the causes separate:

    with the guard     uncollectedTests: []
    without the guard  four entries, every one of them a statement about a config its owner wrote

That contrast is the evidence. The empty list never was.

**Three times in this one investigation an empty result had two sufficient causes**, and each time
only a constructed counterfactual told them apart. The general form is worth more than the finding:
an empty result never names its cause, so where emptiness is meant to prove something, build the case
in which it would be non-empty.

### First evidence on whether the picture step is warranted

0017 makes the picture step conditional on whether a picture answers *where am I and where is the
hole* better than a line does. On the first real case with holes in it, the line answered completely:
two unsupported claims, one underlying fact, and the line names that fact. A diagram would have drawn
two red nodes where the line names one cause — more marks, less insight.

**Boundary, and it decides how this reads.** One specimen, a model of five claims, both holes at the
same stage sharing one fact. So the honest statement is **not** that the graph is unnecessary: it is
that there is no evidence for it and one piece against. The case the graph was proposed for — many
facts with overlapping support, where enumerating in words runs longer than a picture — has not been
seen by anybody yet.

The burden therefore sits with whoever wants to build it, which is the bar 0017 set: a picture must
earn its place on top of a model people already read.

## 2026-09-21 · An exemption that fails open, and the tell that finds it

Teaching the discovery protocol to write hypotheses meant exempting discovery-authored entries from
the check that every identifier documentation names is one the code owns. Their ids belong to the
inspected repository and the code will never own them. The exemption was first written as
`authoredBy === 'construct'` — keep the entries still to be checked — and that shape is the finding.

**Selecting the checked set by a positive match drops everything unanticipated out of scope.** An
entry with the field missing, an entry with a typo in the value, an entry carrying some future third
author: none of them match `construct`, so none of them are checked, and nothing says so. Written as
`authoredBy !== 'discovery'` the exemption covers exactly the case it was written for and leaves
everything else checked. **An exemption belongs as a negation of what is exempt, never as an
enumeration of what is checked** — then it fails closed.

**The defect was in the form, not in its effects.** Before the repair, every `json` block in `docs/`
and `templates/` was read and classified: exactly one repository model exists in the tree, the worked
example in the discovery protocol, and every entry in it is discovery-authored. So nothing had in
fact escaped the check, and no data was ever wrong. This is recorded deliberately, because a note
that reports only the defect sends a later reader looking for corrupted entries that never existed.

**The discriminator separated the two implementations rather than confirming the current one.** The
case added is an entry carrying no `authoredBy` at all: under the old filter it is exempt and the
unowned list comes back empty, under the new one it is checked and the invented identifier appears. A
test exercising a construct-authored entry would have passed against either version and proved
nothing about the change.

**Boundary.** One case. So what this supports is a tell, not a rule: *a gate whose scope is set by a
positive match rather than by subtraction.* It is a narrow instrument — an asymmetry between two
renderers, a one-sided relation between two sets, a summary value collapsing toward reassurance are
all invisible to it — but where it does apply the repair is mechanical, and this file already carries
three other observations about checks run over sets in which the defect could not appear.

## 2026-09-21 · Discovery writes hypotheses on a live repository, and the base it reads is never clean

The first run of the hypothesis step against a real codebase. Specimen C — an adopted single-package
browser library on pnpm, clean at the commit it was read from — was copied with its `.git` into a
scratch directory, adopted with `pnpm dev init --yes --dir <copy>` from this repository's source at
0.8.0, and discovered by following the materialized `.claude/commands/construct-discover.md`. The
original was never written to. Nine of the ten markers were filled; `composition` was left, because
it needs `composition:render` and no `pnpm install` was run in the copy.

**What discovery wrote.** Twenty-one facts — twelve `file-exists`, nine `file-contains` — and six
hypotheses, each standing on between three and five of them: the repository publishes a browser
library rather than a service, a core domain object's lifecycle is an explicit state machine, a
family of competing behaviours over that object is a Strategy, reading a page value is decomposed one
module per source, the host is notified over an event emitter, and formatting has two owners. Every
needle and every path was checked against the tree before it was written.

`doctor` parsed the model and reported all six. Described rather than quoted, under
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md): the `Hypotheses` section
carried six rows, every one `held`, and every one carrying the same annotation — that it was read
from a tree with uncommitted changes and so was never read from the base it records. The capture
itself is not reproduced here, because the hypothesis identifiers in it name the specimen's problem
domain, and editing identifiers inside a block that reads as console output would present edited text
as a capture.

So the answer to the question this run existed to ask is yes: discovery can write a hypothesis, and
`doctor` reads it back.

**The annotation is the finding, and it is structural.** `baseClean` is the cleanliness of the tree
the reading was made from, and on an adopted repository that tree is the one `init` has just written
forty-two files into. The copy's `git status --porcelain` was empty before `init` and carried
twenty-two entries after it; the protocol records cleanliness at step 2, which is inside discovery
and therefore after `init`. `false` was recorded, and it was not a choice — **on a repository the
construct adopts rather than creates, `baseClean` can only ever be `false` unless the adopter commits
`init`'s output first.** Every hypothesis then carries a caveat that is true and says nothing
distinguishing. Nothing is proposed here; the observation is that a field meant to separate careful
readings from careless ones is, in the adoption path, constant. (The field was later scoped to the
evidence under each hypothesis and renamed `evidenceClean` —
[decision 0018](decisions/0018-evidence-clean-scopes-to-the-evidence.md). The names above are the ones
the run recorded.)

**The copy this was measured on predates the rename**, and its `construct.model.json` still carries
`baseClean`. The current parser rejects that file, so re-running `doctor` against that tree meets a
schema error rather than a defect. The tree is scratch and nothing depends on it; this is recorded so
the error is recognised for what it is by whoever meets it next.

**Boundary.** One specimen, one adoption, one adopter who chose not to commit. Whether committing the
`init` output before running discovery is what an adopter would normally do has not been observed at
all.

**Material for the picture step.** Of thirty-seven facts in the finished model, four carry more than
one dependent, and only one carries more than two: `engine-entry`, under four hypotheses. Every chain
from a claim or hypothesis to the facts under it is one hop — the model has no fact standing on
another fact, so the longest path from a claim through enforcement or verification to evidence is
two nodes. The YOU ARE HERE section of the `doctor` output was one
line: `You are here: no claim stops before the end of its chain`.

**Boundary, and it is the same one as last time.** This is the second data point and it points the
same way: a line answered completely, and a diagram of thirty-seven facts whose fan-out is one would
have drawn thirty-seven nodes to say what one sentence said. That still is not evidence that the
picture is unnecessary — it is a second case in which the situation the picture was proposed for did
not arise. Six hypotheses sharing one fact is the densest overlap seen so far, and it is not dense.

**Carry-over on real entries.** A second `pnpm dev init --yes --dir <copy>` reported *Carried over 38
records from the construct.json already here; added 0*. All twenty-one discovery-authored facts and
all six hypotheses came through byte-identical, with `baseSha` unchanged from the first run and
`baseClean` still `false`. The construct-authored half was rebuilt: `mergeModel` replaces every
entry whose author is `construct` with the freshly built one of the same id, and the result was
identical here only because
the construct version and the preset inputs had not changed between the two runs. So what this run
establishes is that the preservation path runs on real entries, not that a rebuilt entry differs.

**What no fact kind could support.** Six things were concluded and none of them entered the model:
that `src/tests` holds exactly one test file; that no dependency policy is declared or enforced; that
the import graph is flat, every directory under `src/` importing every other; that every one of the
fourteen `CaaStates` classes is reachable from a transition; that `src/` is uniformly tabs and double
quotes; and — the sharp half of a hypothesis that did enter — that *nothing* subordinates Prettier to
ESLint, as against the two positive needles proving both are configured. They stayed prose in the
markers, and the wanted facts were named in that repository's `open-questions`, as step 12 requires.

**What the list is evidence of, and what it is not.** Every one of the six is a **count over a set or
a negative**: *exactly one*, *none*, *every*, *nothing*. Not one of them wanted a new *dimension* of
evidence — none wanted to know about git history, about a running process, about anything outside the
files. So if this list argues for a third kind at all, it argues for quantification over a glob, not
for a third thing to look at. That is recorded as evidence and acted on nowhere: one specimen, one
discoverer, and the discoverer knew the two kinds before choosing what to conclude, which is exactly
the bias that would make the list look tidier than the need is.


## 2026-09-21 · Two arguments about timing rest on the same fact

Renaming `baseClean` was argued against on the ground that it would churn a published field, in the
same paragraph as the meaning change was argued *for* on the ground that nothing in the wild carries
a hypothesis yet. Both arguments rest on one fact — whether real data exists — and it points the same
way for both. Invoking it for the meaning and forgetting it for the name produced the right answer to
one question and the wrong answer to the other, a few lines apart.

**The general form.** *It is too late to change this* and *it is cheap to change this now* are not two
considerations to be weighed against each other; they are one claim about the state of the world, read
in two directions. Whenever a change is justified by the absence of data in the wild, every other
change the same absence would license has to be settled in the same breath, because the licence
expires for all of them at once. Here it expires at the first hypothesis anybody writes outside a
scratch copy.

**Boundary.** One occurrence, and it was caught in review rather than by anything mechanical. Nothing
here proposes a check; the note exists because the failure is easy to repeat and reads as prudence
while it is happening.

## 2026-09-21 · The same tree, discovered a second time after the rename

Specimen C was re-discovered rather than patched. The copy adopted on 2026-09-21 carried a model
written before `baseClean` became `evidenceClean`, so the current parser rejects it; renaming the key
by hand would have put the new name over a number computed under the old definition — the cleanliness
of the whole tree — and everything built on that file afterwards would have displayed a hand edit
while looking like a working pipeline. So the copy was reset to that same commit, clean, adopted
again with `pnpm dev init --yes --dir <copy>` from this repository at 0.8.0, and step 12 of the
materialized discovery protocol was run over it again. **The entry above, of the first run, is not
edited: it records what was seen then, and its value is its date.** What follows is a second run, and
the two sets of numbers below are two runs, not a discrepancy between one right and one wrong.

**What this run wrote.** Twenty-six facts — eleven `file-exists`, fifteen `file-contains` — and six
hypotheses standing on between four and six of them, over a model `init` had already filled with
sixteen construct facts and five claims: forty-two facts in the finished file. Every path and every
needle was checked against the tree before it was written. `doctor` parsed the model and reported all
six as `held`, and `You are here: no claim stops before the end of its chain` — one line, as before.
The ten markers were left at their placeholders: this run was the hypothesis step, not the whole
protocol.

**`evidenceClean` is no longer constant, which is what the rename was for.** Three hypotheses read
`true` and three read `false`, on one tree, in one run: the three standing only on the repository's own
committed sources against the three that also stand on `package.json`, which `init` merged into, or on
`eslint.config.mjs`, which `init` wrote. The
first run recorded `false` six times out of six and could not have recorded anything else. This is the
first measurement in which both values are reachable on the adoption path, and it is a measurement of
the scope change, not of the repository.

**The two runs, side by side.**

| | First run | This run |
|---|---|---|
| Facts in the finished model | 37 | 42 |
| Facts discovery wrote | 21 | 26 |
| Hypotheses | 6 | 6 |
| Facts with more than one dependent | 4 | 4 |
| Most dependents on one fact | 4 (`engine-entry`) | 3 (`engine-entry`) |
| Longest chain from an entry to evidence | one hop | one hop |
| `evidenceClean` / `baseClean` true | 0 of 6 | 3 of 6 |
| YOU ARE HERE | one line | one line |

**Two things changed between the runs, not one.** The first ran under the protocol as it stood before
the rename; the second ran under the protocol carrying the `evidenceClean` computation step. So any
difference between the two models is explained equally well by variation from one run to the next and
by the edit to the protocol itself, and this pair cannot separate them. That is the ordinary form of
two points differing in two respects: they are evidence about neither. **And two runs are two runs,
not a spread** — a spread is an assertion about a distribution, which this file's own header declines
to make and which was declined once already over how often an architect failed validation.

**What the comparison supports, and what it does not.** Under that limit it supports two narrow
things: two runs over one tree produced models of the same order — a handful of hypotheses, tens of
facts, every chain one hop — and the counts moved by a few, not by a factor. It supports nothing about
reproducibility of content. The same six interpretations came back under the same six ids, and that
is **not** evidence that the protocol converges: the discoverer of this run had read the entry above
before starting, so the second run was primed with the first run's answers. The honest reading is that
a primed second run agrees with the first, which is the weakest of the possible findings and the only
one this design can carry. A blind second run is what would settle convergence, and nothing here
stands in for it — but blind has to mean more than unread. The first run wrote
`construct.model.json` into that tree, and a second run in the same tree reads that file as ordinary
work and inherits every conclusion in it. Only a run in a fresh copy, where the model does not yet
exist, is blind; reusing the adopted tree is the convenient version of the experiment and is exactly
the contamination.

**Material for the picture step, second reading.** Four facts of forty-two carry more than one
dependent, and the densest is three. One of the four is new in kind rather than in number:
`eslint.config.mjs` is stood on by the construct's own `every-change-passes-the-harness` and by
discovery's `formatting-has-two-owners`, so the fan-in now crosses authors as well as entries. The
rendering of this model — the first of a real model — draws forty-two evidence nodes and eleven
entries, and the four fan-ins are the only thing in it a list could not have shown. That remains a
third reading pointing the same way as the first two, and the readings are not the
thing that is short. The population is.

| Measured so far | What the question needs |
|---|---|
| two runs | several repositories |
| one tree | of differing size |
| about six hypotheses, forty-two facts | tens of claims |
| fan-in at most three | shared infrastructure standing under many entries |
| every chain one hop | |

**Fan-in is a property of scale.** One workflow carrying five claims appears in a large repository,
not in a library with six hypotheses. Forty nodes is the size at which a list wins against a diagram
under any circumstances, and judging the value of a picture there is like judging an index by a
forty-row table.

So the boundary is harder than *the picture has not earned its place*: **the question is not answered,
because no model inspected so far reaches the size at which it arises.** That is not an argument about
models rather than about pictures — it is the absence of a suitable specimen, the same shape as the
missing adopted repository two weeks ago, and it is closed the same way: by finding one, not by
reasoning from the ones at hand.

**An empty result that named no cause, caught by arithmetic.** `evidenceClean` was first computed by a
script that shelled out to `git status --porcelain` per hypothesis and read empty output as clean. All
six came back `true`. The value that gave it away was `published-as-a-browser-library`, which stands
on `package.json` — a file `init` had just merged into, so `false` was the only possible answer. The
cause was environmental: the `git` shim on this machine fails under the x86_64 Python, exits non-zero
and writes nothing to stdout, and the script read the failure as an answer. Re-run in the shell, three
of the six were `false`. The rule this is an instance of is already written down — an empty result
never names its cause — and the instance is worth keeping because the reading was *plausible*: a clean
tree is exactly what an adopted repository looks like a moment before `init` runs. The guard that
worked was not a check but a prediction made before the measurement.

### Two experiments, named, with their candidates

Recorded so they stay experiments with addresses rather than turning back into *someday we will find
a suitable model*.

**Fan-in is measured across the corpus, not hunted for in one specimen.** The question stopped being
*find a model large enough* the moment it was clear that fan-in is a property of structure: several
deployable things sharing one set of infrastructure. That is measurable on repositories already
adopted, and the right column below is a hypothesis, not a finding — testing it is the experiment.

| Structure | Shared infrastructure | Fan-in predicted |
|---|---|---|
| library, one package | one package, one CI, one lint config | 1 |
| service with a contract | one deployable plus its contract | 1–2 |
| workspace monorepo | several apps over shared packages, one CI, one lint config | N |
| application with a backing service | not yet characterised | unknown |
| site with a build and content | not yet characterised | unknown |

Five discovery runs settle it, at roughly three minutes and a hundred thousand tokens each. **If
fan-in is one everywhere, including the monorepo, the picture has nothing to show** — and that is a
conclusion about models in general rather than about one small model, which is more than any amount of
arguing produces. **If it grows with structure**, the graph gets the case it was proposed for, and the
same measurement says who it is for: not everyone, but repositories of a particular shape.

The monorepo carries no `construct.model.json` — materialized before 0.5.0 and brought forward by
`sync` — so its run begins with a first `init`. That makes it also the first case of a pre-0.5.0 tree
acquiring a model, the open question recorded in AGENTS.md, and the two meet in one tree rather than
needing two.

**From this measurement onward, a specimen is described by shape and not by address.** It is written
down here because the entries above this one did not follow it: they named their specimens by scope,
owner and problem domain, and those names were removed by
[decision 0019](decisions/0019-a-specimen-is-described-by-structure.md) rather than by this clause,
which governed nothing while it sat inside an observation. For the specimen set it is absolute: no
repository name, domain or identifying path enters this file, an example or a fixture, on the same
rule the frozen manifests were sanitised under. One of the five is a private site belonging to the
maintainer, and it appears as a structure and nothing else — that constraint goes in the brief of any
run touching the specimen set rather than being remembered at the time. In this file "findings corpus"
always means [0001](decisions/0001-findings-corpus-outside-the-cli.md)'s, never these five.

**The blind run is parked with its price.** A fresh copy plus discovery, twice, so that neither run
can read the other's model. It costs two runs and returns `n = 2` whichever way it falls: weak
evidence of convergence, or evidence of sensitivity to something. Both are worth having and neither
blocks anything, so it waits for a reason rather than being done because it has been formulated.

## 2026-09-21 · Both directions is polarity; every writer is population

A gate kept the generated release page current: it failed when a version appeared in `CHANGELOG.md`
and was not reachable from the site, and failed when the wiring for an existing version was removed.
Two mutations, both directions, each asserted. It shipped a defect that blocked every release —
`changeset version` writes `CHANGELOG.md` when it prepares a version, never calls the renderer, so
every version pull request failed the gate on its own changes.

**Both mutations were performed by one actor**, the renderer, driven by hand. Exercising one writer in
two directions is still one writer. *Both directions* establishes that the gate has the right
polarity; it says nothing about **who else can put the artifact into the state the gate forbids.** In
both cases observed here the writer that was missed already existed, touching the source for its own
reasons with no idea the derived artifact exists, while the writer added alongside the gate called the
regeneration because it was wired deliberately. Two cases do not make that a rule, and stating it as
one would act in the wrong direction: believing it, a reviewer stops enumerating the writers
introduced in the same change as the gate, which is precisely where the next one would come from.

**The sweep, in the shape of the identifier-vocabulary audit.** For every gate over a generated
artifact: the artifact, its source, and every process that writes that source.

| Gate | Derived artifact | Source | Writers of the source | Regenerates |
|---|---|---|---|---|
| `release-notes:check` | `docs/release-notes/index.md` | `CHANGELOG.md` | `changeset version`, bot and local | no, until the version step was made to run the renderer |
| `model:check` | the rendered block in `architecture/model.md` | `construct.model.json` | `init`; the discovery protocol's hypothesis step | **neither did** |
| `composition:check` | the blocks in `architecture/<flow>.md` | `architecture/composition/*.yaml` | a person; the discovery protocol's composition step | yes — that step says to run `composition:render` |
| `doctor` | none | `construct.json` | `init`, `sync` | not this shape: `doctor` reads a source, nothing is derived from it |

**The second row is the same defect, found by sweeping before it fired rather than after.** The discovery protocol writes hypotheses into
`construct.model.json` and said nothing about re-rendering, while the instruction to run
`composition:render` sat nine lines above it for the neighbouring artifact. It had not fired because
the picture is not materialized into user projects — a repository that `init` sets up has no rendered
model to go stale — so the only tree where it can bite today is this one, which renders its own model
and commits it. **That radius grows the day the picture is materialized into user projects**, and the
instruction will already be in the protocol when it does. The step now carries it, and a test requires
it to.

**Boundary.** One defect that fired, one found by sweeping, and two rows that came back clean. That is
an audit, not a rate: nothing here says how many gates in general carry a second writer. What it does
support is that the sweep is cheap — four rows, read off the harness — and that it found something on
its first run.

## 2026-09-21 · Figures measured by a superseded instrument, and the radius drawn round them

A session's worth of cost figures was quoted from the `construct` on PATH, a bundle that reports
`0.1.1` and, on inspection of the bundle itself, predates the response-deduplication fix. The sources
it was quoted against were at 0.8.0. Nothing in any of those numbers said which instrument produced
them, which is the asymmetry [0018](decisions/0018-evidence-clean-scopes-to-the-evidence.md)'s
neighbour now closes for the cost report.

**The methods were reconciled by reading, not by re-measuring.** Two versions of one tool are two
points in one history, so the diffs that touched the counting path are the primary source. Exactly one
commit had changed the arithmetic; one other created the counting and a third touched only the ledger.
Disabling that single guard in the current source made it reproduce the old binary **to the digit** —
265,209,419 billable tokens in 4102 calls, and the same input-equivalent — over an identical set of run
identifiers. **The exactness is the finding**: it confirms deduplication as the cause *and excludes a
second one*. A close match would have done neither, and would have been the more tempting to accept
because a ratio had already been computed. The difference in run counts seen earlier, 59 against 60,
was one run occurring between two invocations, established by diffing the sorted identifier lists
rather than by assuming it was trivial.

**The multiplier is per corpus and there is no general correction.** The share of duplicated responses
depends on how many content blocks the answers in that set happened to carry.

| Corpus | Published, pre-deduplication | Deduplicated | Its own factor |
|---|---|---|---|
| this repository | 265,209,419 billable, 4102 calls | 139,467,665 billable, 2072 calls | 1.9016 billable, 1.9797 calls |
| the workspace monorepo | 149,760,377 billable, 33,331,657 input-equivalent | 76,748,664 billable, 13,254,183 input-equivalent | 1.9513 billable, **2.5148 input-equivalent** |

Two things follow that are easy to get wrong. The input-equivalent factor is not the billable factor,
because the weights differ — so a figure derived from the money-facing number corrects further than
one derived from billable, and which of the two a published figure came from decides its correction.
And **a corpus factor must never be applied to an individual run**: it is an aggregate property of a
set, not a per-run constant.

**The radius over committed records.** The fix that introduced deduplication also corrected the figures
published at that time, in [0008](decisions/0008-a-retry-buys-a-new-exploration.md) and in the
reasoning-budget guide. It did not touch
[0011](decisions/0011-design-is-part-of-the-run.md), which predates it by three days and carries
`2,648,458 billable tokens` and *roughly 2.6M* — **pre-deduplication figures that the correction pass
missed.** The entry is left standing and flagged here rather than edited, and **no corrected value is
stated for it**, because 0011 names no run identifier: two ledger entries match its description, one
of which carries no run id at all and therefore cannot be joined to any measurement. Correcting it is
a bounded task — identify the run, read its deduplicated total — and not one that may be done by
multiplying.

**A figure derived from prices cannot be corrected by any single factor.** The inflation is not
uniform across token classes, and the spread is wide:

| Class | Pre-deduplication | Deduplicated | Factor |
|---|---|---|---|
| input | 5,068 | 2,448 | 2.0703 |
| cache write | 10,589,790 | 4,265,051 | 2.4829 |
| cache read | 137,905,764 | 72,343,960 | 1.9063 |
| output | 1,259,755 | 137,205 | **9.1816** |

Output was counted **more than nine times over**, because a response split across many content blocks
contributed its output once per block, and output is the class that costs the most per token. So a
money figure built from classes at prices is inflated far more than the billable factor of 1.9513
suggests, and by a different amount again than the input-equivalent factor of 2.5148. **The most-cited
figure from this corpus — a cost of a little over two hundred dollars — is therefore recomputed from
the deduplicated class totals above at the prices it used, not divided by anything.**

The rates were never recorded beside the figure; they were stated in conversation on 2026-09-20 when
it was first computed, taken from the price list rather than from memory: **$5 per million input, $25
output, $10 hourly cache write, $0.50 cache read.** They are fixed here from that conversation, not
read off the price list today — substituting current prices would silently swap one input for another
and produce a new number dressed as a corrected old one. They can be checked rather than trusted: at
those rates the *pre-deduplication* classes come to **$206.37**, which is the figure as published, so
the rates reproduce their own output.

**Read the classes before the totals**, because the totals invite division and the classes are what
forbid it:

| Class | Pre-deduplication | Deduplicated | Its own factor |
|---|---|---|---|
| input | $0.03 | $0.01 | 2.0703 |
| cache write | $105.90 | $42.65 | 2.4829 |
| cache read | $68.95 | $36.17 | 1.9063 |
| output | $31.49 | $3.43 | **9.1816** |
| **total** | **$206.37** | **$82.26** | — |

Output fell by more than nine while cache reads fell by less than two. **No scalar exists** that takes
the published figure to the corrected one; the total's apparent ratio of 2.5086 is an artefact of this
particular mix of classes and would be wrong for any other run.

**The corrected figure inherits the caveat the original carried, and it must travel in the same
sentence.** The published two hundred dollars was a **lower bound**: it counted the ladder's subagents
only, with no orchestration and no architect calls made outside the ladder. So does $82.26. Small
numbers travel further than large ones, and a figure that sheds its qualification while shrinking will
be quoted more confidently than the one it replaced.

**A money figure is computed from three inputs — the data, the instrument and the rates.** The data was
identified in the ledger, the instrument is what this entry adds, and the rates had been written
nowhere. Constants are the input most reliably lost, because at the moment of calculation they are
obvious.

**The missed file is a symptom-driven repair covering the symptom's population.** The commit that
corrected the published figures fixed the places it had been shown, and its subject line — *correct
every figure that defect published* — reads as exhaustive. It was not, and `0011` is what it did not
happen to be looking at.

**Boundary.** Two corpora, both measured at one moment with two instruments over identical identifier
sets. Nothing here establishes a factor for any third corpus, and the reconciliation's exactness is
evidence about these token streams rather than about the counting of token streams in general.

## 2026-09-21 · A gate can sit outside the path the change travels

A fourth way for a gate to be present and useless, independent of the three already recorded here. It
is not that it cannot fail — it can. It is not that its set excludes the defect — the set is right.
And it is not that it has never been shown firing — it fires when run. **It simply does not run on the
change that would trip it.**

`docs:anchors` verifies that every anchored link in the navigation resolves to a heading in the
rendered page. It was wired into the documentation deployment, which runs on pushes to the default
branch and never on a pull request, under a path filter of `docs/**`, the workflow and `package.json`.
The anchors are produced by `scripts/release-notes/`, which matches none of those paths. So a change to
the code that generates the anchors would not have triggered the check at all, and a change that broke
them would have been checked only after it had already merged.

**The tell: the gate's trigger condition does not cover the inputs of the artifact it guards.**

**The column this adds to the writers audit.** That sweep asked who writes the source. This one asks
when the gate runs and whether that covers them.

| Gate | Source and its writers | When the gate runs | Trigger covers the writers |
|---|---|---|---|
| `docs:anchors` | the rendered page, from `scripts/release-notes/` | was: push to default branch, `docs/**` | **no — found** |
| release index checks | `CHANGELOG.md`, written by `changeset version` | `pnpm run quality` | yes |
| `model:check` | `construct.model.json`, written by `init` and by discovery | `pnpm run quality` | yes |
| `composition:check` | `architecture/composition/*.yaml`, written by a person and by discovery | `pnpm run quality` | yes |
| secret scan, dependency audit | the tree | pull request, push, weekly | yes |
| release verification | what the release workflow published | on that workflow completing | yes |

**The three that live in the harness are clean for a reason, not by construction.** `ci.yml` triggers
on `pull_request:` with **no path filter at all**, and on pushes to the default branch. That single
absent line is what puts every gate inside `pnpm run quality` on the route of every change — and it is
one line somebody could add later while tidying CI, which would move all of them off the route at once
without touching a gate. A test now asserts the harness trigger carries no path filter, and reads the
block first to confirm it is looking at a real trigger rather than at nothing.

The remedy for the one that was found was to move it onto the route rather than widen the route to it:
the documentation build costs 0.82 seconds, so the check now runs inside the harness. The path filter
was widened as well, so the deployed build is still checked when its inputs move.

**The property rests on two conditions and only one of them was asserted.** *The harness runs on every
change* is now held by the no-path-filter test above. *Every gate lives inside the harness* was held by
nothing — and it is the one that was actually broken, because `docs:anchors` existed, was correct, and
sat outside. A test about the trigger would not have caught it: it inspects the route, not the
membership.

So membership is now a partition of the same kind used for identifiers: every script in the manifest is
either on the harness route — reached from `quality`, or reaching it — or declared outside it **with a
reason**. A script that is neither fails the check, so adding a gate and wiring it somewhere else is no
longer a silent act. The mutation lifts `docs:anchors` back out of `quality` and the script becomes
unclassified. The declaration also made one honest exemption visible that had never been written down:
`release:verify` is a gate and belongs outside, because it inspects what was published and that does
not exist while the harness runs.

**This is the condition that will keep breaking, and the reflex says why.** A gate gets attached to the
thing it inspects rather than to the path changes travel — `docs:anchors` went into the documentation
workflow because that is where documentation is built. Nobody will remove the harness's coverage of
every change; people will keep hanging new gates off the artifact they watch.

**Boundary.** Six gates, one hit, and the hit was the newest of them — written the same day, wired into
the workflow that happened to be nearby. Nothing here says the rate is one in six; it says the sweep
is one extra line of reading per gate and found something on the first gate it looked at.

## 2026-09-21 · The first measurement of what an L0 step is worth

Recorded as a ledger finding and it is not one. The ledger is the instrument; the subject is the
enforcement level. This repository has graded controls L0 to L4 all month and labelled them honestly,
L0 meaning *nothing enforces this*. Underneath every such label sat an unexamined assumption: that an
L0 step is performed unless somebody is careless. One has now been measured.

### 2026-09-21 · Half the ladder runs were never recorded, in every session alike

The ledger holds 29 readable entries against 65 runs the runtime knows about. The 36 without an entry
were measured rather than guessed at, and the result is not what the phrasing *runs that were never
logged* suggests.

**They are not historical.** The step that writes the ledger entered the `/implement` instructions on
2026-09-16, before every one of these runs. Nothing here predates the rule it breaks.

**They are not one operator's lapse.** Grouped by the session that launched them, the split is even
everywhere:

| Session | Recorded | Not recorded |
|---|---|---|
| first | 15 | 15 |
| second | 13 | 17 |
| third | 1 | 4 |

The session that recorded thirteen and missed seventeen is the one in which this entry was written,
by an operator who wrote a ledger line after every run he noticed finishing.

**They are not all the same kind of run**, and the split matters for what to do about it:

| | Count |
|---|---|
| reached verification — a completed run, simply never recorded | 26 |
| never reached it — stopped or failed before the harness ran | 10 |
| of those, no agent completed at all | 2 |

So the deferred *stopped run* class is ten of the thirty-six, not a corner case and not the bulk
either. The larger share is twenty-six ordinary completed runs whose entry was never written.

**The cause is the enforcement level, and it is already stated.** The ledger line is written by hand by
whoever ran the ladder, after reading the result; the workflow sandbox has no filesystem, so the script
that knows the outcome cannot record it. The instructions say plainly that nothing enforces this step.
What was missing was not a rule but a measurement of how often an L0 step of this shape is actually
kept — and the answer, over three sessions and five days, is **about half**.

**It has already cost something specific.** [Decision 0011](decisions/0011-design-is-part-of-the-run.md)
carries a figure measured by a superseded instrument that cannot be corrected, because it names no run
identifier and one of the two ledger entries matching its description has no run id to join on. An
uncorrectable record is the concrete form of this gap; before today it was an abstraction.

**What the drift line can and cannot say.** `construct cost` reports every session with no entry, and
it names them. Until today that reconciliation existed and printed nothing, for reasons recorded above.
Now that it prints, the number is visible on every run of the tool — which is a compensating control
for an L0 step, not a replacement for it, and it is worth nothing unless somebody reads it.

### What this calibrates, and what it does not

**Every past label of the form *L0, held by review* now reads differently than it was written.** Not
*performed unless forgotten*, but *performed about half the time*. The ownership rule in
[model.md](model.md), the discovery protocol's steps, the deferred-question check in
[0017](decisions/0017-v5-adds-no-new-way-of-knowing.md) — none of them changes, and all of them now
carry a calibration they did not have this morning. That is not an argument against labelling honestly:
it is what the honest label was always worth.

**The remedy is not a louder instruction.** The step is L0 **by construction rather than by oversight**:
the workflow sandbox has no filesystem, so the component that knows the outcome cannot record it, and
the knowledge must travel by hand to something that can write. The solution space is therefore moving
the write to where knowledge of the outcome and the ability to persist it meet — not instructing more
emphatically, which is an L0 control stacked on an L0 control. This repository refused that three times
today in code; it is no better in a process. The question for an unenforced step is not *how do we
remember it* but *why can the thing that knows not record it*.

That question has a place to start. The outcome crosses the sandbox boundary at one known moment: when
a run returns its result to the session that launched it. The code servicing that handover holds the
outcome and a filesystem at the same time, and it is the only point where both conditions are met —
which makes it the first place to look, and, as far as this analysis goes, the only one. Whether a
write belongs there is not settled here; where to look is.

**Boundary, and it is narrow.** One step of one shape — append a line by hand after reading a result —
thirty-six missed runs, two operators, three sessions, five days, one repository. **Not a rate for L0 in
general.** It is the first number of any kind where there had previously been an assumption, and
nothing in it says whether a prompt, a checklist or a different placement would move it, because none
of those was tried.
