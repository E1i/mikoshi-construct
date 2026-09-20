# 0016 — The model is the source; doctor, the graph and reports are projections

Status: proposed · 2026-09-20

## Context

The state of a repository is currently assembled independently by each consumer. `doctor` computes
its own checks, `sync` classifies paths on its own terms, the invariants table is prose with a
column, composition models describe structure in YAML. Each is right about its own part, and none
of them can be asked one question: what does this tool hold to be true here, and on what grounds.

The first sketch of this work made the graph the source of state for `doctor`. That puts a renderer
in charge of truth.

## Decision

A single machine-readable model is the source: facts, claims, evidence, enforcement, verification,
state and the relationships between them, with a schema, fixtures and validation tests. `doctor`,
the graph and every report are projections of it and hold no state of their own.

The model does not replace `construct.json`. The invariant, in the form a reviewer can apply:

> `construct.json` is the authority for file provenance; the model is the authority for repository
> knowledge. They are separate authorities, not two views of the same state. Neither may become a
> second source for facts owned by the other.

Concretely:

- `construct.json` records what `init` and `sync` wrote, changed, or own.
- The model records claims about the repository, the evidence supporting them, and how those claims
  are enforced and verified.
- File provenance must not be duplicated into the model; repository claims and their enforcement
  must not be duplicated into `construct.json`.

Path selection and tie-breaking — the rule that picks the point where a chain stops being held — are
part of the model contract, not of whatever renders it. The same model yields the same answer.

## Consequences

Any consumer added later — the graph, a badge, the future filter — reads one object rather than
re-deriving the picture, which is what made the same figure wrong in two places (see
[decision 0014](0014-a-check-answers-only-about-what-it-was-shown.md)).

The model is committed, not generated on the fly, so it is reviewable in a diff. Entries written by
discovery carry their author, as markers do, because that half is not reproducible.

## Enforced by

Review (L1): the invariant above is applied directly. A design that gives the model a `files`,
`managedFiles` or `provenance` section, or that reads `construct.json` to build repository
knowledge, is rejected by this decision without further discussion — those are examples of the
violation, not the whole of it.

Schema validation over fixtures (L3). The no-second-source assertion: a claim placed in
`construct.json`, or a file hash placed in the model, must fail validation (L3). A fixture with two
chains stopping at equal depth, pinning the tie-break (L3). A check that `doctor` computes no state
absent from the model (L3, lands with 5.1, when `doctor` first reads the model).

Ownership inside the model is `authoredBy` and nothing else, as
[architecture/model.md](../model.md) states. While `init` is its only consumer that rule is L1,
review — there is one decider, so there is nothing to diverge from. When `doctor` becomes the second
consumer in 5.1 it gains a real surface, and 5.1 acceptance carries the mutation gate that raises it
to L3: make `doctor` derive ownership from anything other than `authoredBy` — from what references
an entry, from preset membership, from position — and the gate must fail.
