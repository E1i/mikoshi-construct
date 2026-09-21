# 0027 — An acceptance is red before the implementation exists

Status: accepted · 2026-09-22

## Context

The lifecycle this repository describes runs discover, plan, implement, verify, review, harden. Between
the brief and the implementation there has been an unnamed stage, and it has been doing real work:

```
brief  →  ???  →  implement  →  harness
```

The `???` is **acceptance discipline**. Three entries in [observations.md](../observations.md) record
what it has done and what it costs, and this record is written from them rather than restating them:
*Six stops on a false premise, in one night*, *A rule with no independently checkable carrier is
carried by memory*, and *Three plans that ended in not building, each with its reason recorded*.

**It is not the reasoning ladder, and extending the ladder to cover it would be false.** The two
answer different questions and neither substitutes for the other:

| | the question it answers |
|---|---|
| acceptance discipline | may we proceed to reasoning at all — has the implementer shown they know what they are checking? |
| the reasoning ladder | how much reasoning to give, once the harness says the solution does not work |

A new normative area takes a new number. [epistemic-rules.md](../epistemic-rules.md) fixes a rule's
scope at the moment it is written, for the reason that widening one silently changes every citation
already made of it; the same holds for a ladder that would quietly acquire a job it never had.
Widening it would produce an architecture that reads well and is false, which is the outcome
[0019](0019-a-specimen-is-described-by-structure.md) and
[0021](0021-a-record-of-the-past-is-not-edited.md) were kept apart to avoid.

## Decision

**An acceptance must be red on the current tree before the implementation exists.**

One mechanical test, rather than a list of habits. A criterion that cannot be shown failing is a
statement of intent, however specific its wording:

| | |
|---|---|
| *Verify the implementation is correct* | passes a checklist, cannot turn out false |
| *Acceptance criteria defined* | passes a checklist, cannot turn out false |
| *For each preset, `buildModel` from the recorded manifest yields exactly these claim ids* | holds or does not |

The difference is not specificity. The third has an outcome; the first two have a tick.

### Where the teeth are

Every checkpoint in this stage is answered by the implementer about their own work. So the answer is
worth nothing and the artifact is worth everything:

| the checkpoint returns | what it is |
|---|---|
| `baseline reproduced: yes` | an opinion — L0 with extra steps |
| a hash, a command's output, a test shown red | evidence a second party can read |

The discriminator, stated as a rule rather than as advice: **a checkpoint is met by producing
something a second party can check without taking the first party's word.** Where the checkpoint
produces only a judgement about one's own work, it has not been met, whatever the judgement says.

### The two stops

**If the baseline cannot be reproduced, stop and report.** Do not proceed on the assumption that it
would have reproduced. A defect that cannot be made to appear is not thereby understood, and an
implementation built on it is being verified against a guess.

**Never adjust the criterion to make the test green.** A criterion changed to fit the result it met is
not a criterion; it is a description of the outcome. Where the measurement contradicts the criterion,
the finding is the contradiction, and the criterion moves only by being replaced deliberately and
said out loud.

### The condition that makes it work

In every one of the six observed stops **the party who wrote the acceptance was not the party who
measured it**. Five falsified the premise of the session that wrote the criterion and one the premise
of the session that implemented against it; the distribution is in the observation, and the mechanism
does not depend on it.

A stage where the same party writes and tests its own acceptance is a much weaker thing, because the
premise and the measurement then come from one reading and nothing outside it is consulted. This
record states the condition rather than leaving the mechanism to be adopted in a form that cannot
bite.

## What this replaces, and what it leaves standing

[the-cycle.md](../../docs/guide/the-cycle.md) §3 already carries two rules, and the relation to each
was measured rather than summarised:

| the existing rule | what happens to it |
|---|---|
| *A criterion is verified by what the task changes itself* | **survives unchanged.** It bounds what a criterion may depend on. It says nothing about whether the criterion has ever been shown failing |
| *Contract and composition first* | **untouched.** It orders tasks against each other and is not about criteria at all |

What this record adds is red-before-implementation, which **neither of them provides**: both are
satisfied in full by a criterion that has never been shown failing. So §3 keeps its two rules and
gains a pointer here, and this record carries the third. There is one source on each of the three
statements, which is what the protocol requires.

## The rule fired on its own text before it existed

This record was asked for once and not written. It was to cite three observations that did not exist
in the repository — a search across `main` and every branch carrying entries found one session
record, not three — and citing them would have been a reference into nothing, while restating their
content instead was excluded by the brief. The baseline could not be reproduced, so the work stopped
and reported, and the observations were written and merged first.

That is the stop above, applied to the record that codifies it, and it is so far the only instance in
which the mechanism was tested on itself.

## What this does not do

**It introduces no new entity.** No process model, no acceptance model, no field in `construct.json`
or `construct.model.json`, nothing rendered, nothing to keep in sync.

**It does not answer where the carrier lives or who checks it.** That is the next question. Building
an architecture for it inside this record would answer it by accident, and the answer would then be
cited as though it had been decided.

**It does not claim to be enforced.** See below, and read it as written.

See also the observation *An acceptance played a second role at 0027's first use, and the rule
describes only the first* in [observations.md](../observations.md), which records a role an
acceptance plays that the single mechanical test above does not describe.

## Enforced by

**L1 review — and by memory, which is the weaker half.** Nothing today can report a violation: an
acceptance that was never red leaves no artifact behind, so a stage skipped and a stage performed are
indistinguishable from outside. By the entry *A rule with no independently checkable carrier is
carried by memory*, this record is an instance of exactly what that entry describes, and saying so
here is cheaper than letting a later reader discover it.

It becomes **L3** when a run leaves evidence that a second party can read: the acceptance stated as a
command and the state it fails in, its first result recorded red, and the implementation commit
recorded after it — with a check asserting that every run carrying an implementation carries that
pair. The run ledger is the obvious place and is itself L0 today
([0003](0003-run-ledger-stops-at-l0.md)), so the mechanism would have to be built on something with a
carrier of its own. Naming the mechanism is not building it, and this record does not.

### Three steps, and the second is the one that will be misread

The path from here to a carrier has three rungs, and they are written separately because collapsing
them into one is how the claim gets ahead of the work:

| | what changes | where the rule stands after it |
|---|---|---|
| today | the rule is in this record only | the planning agent does not read it at all — L1, and memory |
| the template, and this repository's copy of it | `templates/ai/shared/_claude/commands/plan.md` and `.claude/commands/plan.md` state the rule, so the agent reads it | **L0.** It is prose an agent may follow or not, exactly like the discovery protocol |
| the run leaves evidence | the acceptance, its red result and the implementation commit are recorded, and something checks the three are present | L3 |

**The middle rung is necessary and is not sufficient**, and it is the one that will be reported as
completion. The day the template lands, the natural sentence to write is *0027 now works* — and that
sentence would be wider than what was done, which is the defect recorded in the entry *A claim with a
complete lifespan*, where a true statement about a record layer stood for ten minor versions as a
statement about the whole. Naming the rungs apart is the cheapest available guard against writing it
again.

### Where the chain of carriers stops

Asking what carries a rule invites the same question about the carrier, and about that carrier's
carrier. Without a stopping condition the question regresses and cannot be answered, so it is stated
here:

> **The chain stops at the first level where enforcement can fail without a human deciding it has
> failed, and where that failure has been demonstrated on a real case the carrier was expected to
> catch.** Above that point no further carrier is required.

Both clauses are load-bearing, and this repository already carries an example of each failing and
holding.

**A mechanism whose violation has no outcome of its own does not stop the chain.** The dependency
audit in `security.yml` runs under `continue-on-error: true`: it reports into the log, its check is
green whether or not it found a vulnerability, and nobody is obliged to read it. Whether the invariant
held is then decided by a human noticing, which is the first clause failing — and the level scale in
[decisions/README.md](README.md) already calls such a check L0 for exactly this reason, however much
machinery stands behind it.

**A mechanism whose ability to fail has only been argued does not stop the chain either.** The
post-publish smoke satisfies the second clause in the form this record means: it was run against the
last release that carried the defects it exists to catch and failed on it — `a second init changed
construct.model.json, AGENTS.md` on 0.12.2 — and passed on 0.13.0. That is a demonstration on a real
artifact rather than on a mutation of our own making, and it is the difference between knowing a
carrier fires and believing it would.

So the answer to *what carries the carrier* ends at a mechanism that fails by itself and has been
seen to. It is not that nothing above it could be checked; it is that nothing above it needs to be,
and a chain with no stated end produces an architecture of carriers rather than an enforced rule.

**Boundary.** Six stops, one operator, one project, one reviewing session, one night. A form, not a
rate. It does not say how often this stage stops anything, and it does not establish that a session
without it would have shipped the falsified premises.
