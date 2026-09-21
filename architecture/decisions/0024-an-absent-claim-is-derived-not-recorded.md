# 0024 — An absent claim is derived on read, never recorded

Status: accepted · 2026-09-21

## Context

[0020](0020-a-claim-is-written-only-where-its-evidence-holds.md) stopped `init` writing a claim whose
evidence does not hold, and left an open question: how `doctor` could say *why* the set of claims is
short. It observed that the model keeps no trace of a claim that was not made, and treated that as
the obstacle.

## Decision

**The set of claims a preset can make is recomputed on every read, from what is already on disk, and
compared with what the model carries.** Nothing about it is persisted: no new entry, no schema
change, no `MODEL_VERSION` bump, no field in `construct.json`, nothing written by `init`.

```
construct.json → buildModel(preset, vars) → expected claim set
               → compared with construct.model.json → reported
```

For each claim expected and absent, its facts are evaluated against the tree by the same machinery
that evaluates the ones the model carries, and what they say is reported in one of the three forms
below. A claim absent because its sample was never materialized then reads as *the file its fact
names is not here* — present tense, true, and requiring no knowledge of what happened at `init`.

### Why derivation beats a trace

A trace states what was true at `init` and goes stale silently: an owner who adds the missing needle
keeps being told about an absence that has ended. A derivation stops being reported the moment it
stops being true.

That is the rule the rest of the model already follows — every state derived on read, never stored,
which is why a hypothesis cannot rot into a lie and why no `confidence` is recorded beside one. A
stored absence would have been the only exception in the model, and it would have been the one entry
nothing could refute.

### The expected set is what the preset CAN claim, not what one run DID materialize

`sample` is taken from the preset, not from the run that wrote the manifest:
`sampleGroups(getPreset(manifest.preset)).length > 0`. Both inputs are already recorded, so this
persists nothing.

The distinction is not a detail, and a failing test is what established it. Building the expected set
with `sample: true` unconditionally made `node-library` expect `lint-policy` — a claim that preset
**cannot make at all**, because it ships no sample group and therefore never produces
`scripts/tests/lint/syntax-policy.test.ts`, the file that claim stands on. Reporting it absent would
be a statement about the preset wearing the clothes of a statement about the repository: the `hook`
defect in a new coat, reintroduced from the opposite side of the same gap 0020 closed.

So the rule is: a claim is expected where the preset can make it, and absent where this repository
does not carry it. For `node-library` and `lint-policy` only the first half fails, and nothing is
said.

### Three readings, because a fact has three evaluations

An absent claim is reported in one of three forms, and which one is chosen never depends on the order
its facts are named in:

| What the facts say | What is reported |
|---|---|
| One does not hold | that file does not carry what the claim would stand on |
| One could not be read, and none fails | that file could not be read, so whether the claim would stand cannot be determined |
| Every one holds | every fact holds, and `construct init` would record the claim |

Collapsing the first two into "not `holds`" would merge two different states — *this is false here* and
*we could not look* — which [rule 2](../epistemic-rules.md) exists to keep apart, and would leave the
choice between them to the declaration order of `supportedBy`. Where both are present the failing
fact is reported, because it is the one a reader can act on; the unreadable one is reported only when
nothing fails.

The third form is the one this block exists for. A claim whose every fact holds and which the model
does not carry is fully supported today and absent only because an earlier `init` did not write it.
Dropping it would restore the silent omission from the other side — which is distinct from a claim
whose facts hold and which the model *does* carry, since that one is already in the enforcement trace
and is never named here. Membership in the model is what separates the two, not the state of the
facts.

## Consequences

**On an adopted repository whose owner wrote their own `ci.yml` and `security.yml`, five claims are
named on every run** — four for the workflows, and `lint-policy` for the sample that tree never took,
until the owner adds `scripts/tests/lint/syntax-policy.test.ts`. The count is five rather than four
because such a tree is adopted by definition, and the two reasons are separate. That is intended. It is
an absent claim like any other: true while it is true, actionable, and gone the moment the file
appears. It is recorded here so that a later reader does not take a recurring line for a defect.

An absent claim is not an enforcement verdict and is not printed as one. It carries no level, because
nothing is enforced by a claim that was never made, and it appears in its own block rather than in
the checks.

`doctor` gains a `notCarried` field, classified as knowledge in `DOCTOR_FIELD_FAMILY` because it can
change without anything `init` wrote changing.

## Enforced by

`tests/expected-claims.test.ts` (L3), which is the load-bearing one: for every available preset,
`buildModel` from the manifest's recorded preset and vars yields exactly the claim ids that preset's
model carries. If the inputs ever stop being sufficient, this fails before anything derived from them
is believed.

`tests/claims-not-carried.test.ts` (L3) pins both directions: nothing is printed where the tree
carries every expected claim; nothing is said about `lint-policy` for a preset that cannot make it;
`lint-policy` is named with the file that is not there on a preset that can; each of the five
withheld on an adopted owner-authored-workflow tree is named once with the fact that does not hold;
a fact that could not be read is distinguished from one that does not hold, and a failing fact is
preferred over an unreadable one even when named after it; a fully supported claim the model carries
is absent from the block while a fully supported claim it does not carry is present; and no such line
carries a level.
