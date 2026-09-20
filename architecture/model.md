# The repository knowledge model

`construct.model.json` is what this tool holds to be true about a repository, and on what grounds.
It carries facts, claims made by the construct, hypotheses written by discovery, and the way each
one is enforced and verified.

It is a separate authority from `construct.json`, not a second view of it:
[decision 0016](decisions/0016-the-model-is-the-source.md) draws the line — `construct.json` is the
authority for file provenance, the model is the authority for repository knowledge, and neither may
become a second source for what the other owns. `doctor`, the graph and every report are
projections of the model and hold no state of their own.

The vocabulary below lives in `src/model/`. This document is its second reader:
`tests/model-vocabulary.test.ts` reads the enums from the source and fails when a member is not
explained here.

## Facts — what can be pointed at

A fact is something deterministic code can look at without judgement
([decision 0015](decisions/0015-interpretation-stays-with-the-agent.md)). There are two kinds.

| Kind | What it asserts |
|---|---|
| `file-exists` | The file at `path` is present in the repository. |
| `file-contains` | The file at `path` is present and contains the literal `needle`. |

Everything else in the model — a claim, a hypothesis, an enforcement — stands on facts by naming
their ids in `supportedBy`. Nothing stands on prose.

## Fact evaluations — the answer for one fact, now

A fact is evaluated on every read; the answer is never stored.

| Evaluation | Meaning |
|---|---|
| `holds` | The file was read and the assertion is true of it. |
| `does-not-hold` | The file was read, or shown to be absent, and the assertion is false of it. |
| `unevaluable` | The fact could not be evaluated at all — the read failed. |

`unevaluable` exists because a failed read is not a finding. [Rule 2](epistemic-rules.md) keeps
`unknown` and `absent` apart: absence is asserted only with full scope evidence, and not having
looked is not evidence of anything.

## Model states — what a chain of facts yields

A claim's enforcement, a claim's verification and a hypothesis each resolve to one state, derived
from the facts named under them. The state is never written into the file.

| State | Meaning |
|---|---|
| `held` | Facts are named, every one was evaluated, and every one holds. |
| `unsupported` | Facts are named, every one was evaluated, and at least one does not hold. |
| `unknown` | No fact is named, or a named fact was `unevaluable`. |

### Why `unsupported` and `unknown` differ

`unsupported` asserts a negative — *this is not true here* — and that is only honest when every
named fact was actually looked at. One fact that could not be read turns the whole chain `unknown`,
never `unsupported`. A chain with no facts under it is `unknown` too: nobody looked, so there is
nothing to report.

### Why there is no state and no confidence in the file

State is derived on every read because a stored state is a claim about a repository that has
changed since. And no `confidence` number is recorded, under any name:
[rule 7](epistemic-rules.md) says confidence does not replace an evidence state, and a number beside
a hypothesis invites exactly that substitution — a reader takes 0.9 for *known* and 0.4 for
*unknown*, when both are silent about whether anything was checked.

## Enforcement levels — how strongly a claim is held up

| Level | Meaning |
|---|---|
| `L0` | Text only: the claim is written down and nothing checks it. |
| `L1` | Review: a human applies it. |
| `L2` | A local hook runs the check. |
| `L3` | CI runs the check and reports. |
| `L4` | CI runs the check and blocks the merge. |

An enforcement is never a bare level. It carries a `mechanism` and the `supportedBy` facts that hold
that level up, because [rule 8](epistemic-rules.md) separates the presence of a command from the
level at which it is enforced: a script in `package.json` with no hook and no CI is L0, not L2. A
level whose facts stop holding therefore becomes `unsupported` rather than staying a number nobody
can check. [Rule 1](epistemic-rules.md) is the same separation one step earlier — the claim, the
thing that checks it, and how strongly it is checked are three facts, not one column.

## Chain stages — where a claim stops being held

A claim is read as a chain, in this order.

| Stage | Meaning |
|---|---|
| `enforcement` | Something requires the claim, at a named level, on named facts. |
| `verification` | Something demonstrates the claim actually holds, on named facts. |

The chain stops at the first stage that is not `held`, and that point is what `doctor` reports as
where you are. A claim stopping at `enforcement` is further from done than one stopping at
`verification`, so the shallower stop is selected first. When two claims stop at the same stage,
declaration order in the model breaks the tie: the first claim declared wins. Path selection and
tie-breaking are part of the model contract, so the same model always yields the same answer
([decision 0016](decisions/0016-the-model-is-the-source.md)).

## What the model deliberately does not add

None of this is a new way of knowing. Every state above is derived from a file read or a literal
match that the tool could already do; the model only holds them in one object
([decision 0017](decisions/0017-v5-adds-no-new-way-of-knowing.md)). Recognition of an unfamiliar
stack improves by improving the discovery protocol, which writes better hypotheses, not by adding
detectors to the CLI.
