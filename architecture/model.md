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

## Authorship — who wrote an entry, and what `init` may rewrite

Every fact, claim and hypothesis carries an `authoredBy`, from one list shared by all three.

| Author | Meaning |
|---|---|
| `construct` | `init` wrote the entry from the preset, and `init` owns it. |
| `discovery` | The discovery protocol wrote the entry from what it found in the repository. |
| `unknown` | The entry was not written by the construct and its author was not recorded. |

`authoredBy` is the sole source of ownership for model entries. `init` may replace only entries
authored by `construct`; entries with any other author are carried over unchanged. No other way of
deriving ownership is permitted — not from what references an entry, not from whether the preset
still produces it, not from where it sits in the file. A second derivation would give one question
two answers, and [decision 0016](decisions/0016-the-model-is-the-source.md) exists so that the model
gives one. Nothing checks this rule mechanically: it is held by review, and it is written here so
that the next consumer reads it rather than inventing its own answer.

`init` is additive, exactly as it is for the manifest
([decision 0013](decisions/0013-a-second-init-adds-to-the-record.md)). A second run rewrites only the
entries whose author is `construct`: one the preset still makes is replaced with the freshly built
version in the place it already held, one the preset no longer makes is dropped, and everything
authored by anyone else is carried over untouched. Entries that survive keep their relative order,
because declaration order in `claims` breaks ties; only genuinely new entries are appended. A
construct-authored fact another surviving entry still stands on is kept, so the merged model always
parses.

The consequence is worth stating plainly: **a hand-edited entry still authored by `construct` is
overwritten by the next `init`.** Change its `authoredBy` to `discovery` or `unknown` and the edit
survives. There is no force flag and no backup file; ownership is the only thing that decides.

### When a construct-authored fact stops matching

A fact the construct wrote can stop matching for more than one reason. The path it names may move —
a workflow renamed. Or the shape of what its needle looks for may change — a script rewritten into an
equivalent form, a command lifted into a script of its own. The derived state is `unsupported` either
way, and it means **this fact no longer matches**, not *the enforcement is gone*. Those are different
sentences, and only the first one is being asserted.

The supported way out is the same in every such case, and does not vary with the reason: change the
fact's `authoredBy` away from `construct` and edit it to match, accepting that `init` stops
maintaining that fact and that later corrections shipped with a preset will not reach it. Editing the
fact while leaving it authored by `construct` is not a fix — the next `init` overwrites it, which is
the ownership rule above working exactly as written. Putting the file or the wording back the way the
construct expects is the alternative, and it is the better one only where the change was accidental.

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

## Claims are about mechanisms, not goals

A claim carries exactly one `enforcement`, and that is deliberate. [Rule 1](epistemic-rules.md)
separates three facts — that something is required, that something checks it, and how strongly it is
checked — and the schema keeps them apart by giving one claim one checker at one level. "Every change
passes the harness through CI" and "every change passes the harness through a local hook" therefore
say the same *goal* but name two different mechanisms, so they are two claims, not one claim with two
enforcers.

Read as goals they look like duplicates, and merging them looks like tidying. Read as mechanisms they
are not: CI holds at L3 and a hook at L2, they stand on different files, and either can stop holding
while the other still does. A single claim with two enforcers would have to answer "is this held?"
with one state for two independent mechanisms — which is exactly the one-column table rule 1 exists to
prevent. Keeping them apart is what lets `doctor` say *which* mechanism stopped holding, and lets a
repository that has one and not the other be described honestly rather than half-credited.

## Where a verdict belongs — knowledge or provenance

A verdict is **knowledge** if it can become false without anything `init` wrote changing. It is
**provenance** if it becomes false only when what `init` installed has changed — and provenance is
`construct.json`'s question, not the model's
([decision 0016](decisions/0016-the-model-is-the-source.md)).

`harness-steps` is knowledge. It asks whether the harness command really runs lint, typecheck and
tests; the `package.json` it reads belongs to the repository's owner, who can rewrite the script
tomorrow without touching a construct file. The claim can go from held to unsupported with the
construct untouched, which is what makes it worth holding. Where the preset materializes an HTTP
contract, the `contracts:check` step of that same command stands under the same claim, for the same
reason. What stays provenance is the record around the command: that `package.json` is there, that
it carries the script `construct.json` named, and that the contract paths that manifest records
resolve.

`construct-tests` is provenance. It asks whether the test files `construct.json` recorded are still
collected by the runner config `init` also wrote: both ends were installed by the construct, so the
answer changes only when the construct's own files changed. That reasoning holds only while the
construct owns both ends. Where a repository arrived with its own runner config, the construct never
wrote that end, and a verdict there would pronounce on a file its owner owns — so the check must stay
silent instead. That makes `construct-tests` conditional in the same way `lint-policy` is: the same
rule, a different condition. `lint-policy` exists only where the preset's sample was materialized,
because only then did the construct write the policy test it stands on.

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
