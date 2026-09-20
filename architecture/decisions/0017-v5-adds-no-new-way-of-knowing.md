# 0017 — v5 adds no new way of knowing

Status: proposed · 2026-09-20

## Context

Everything this work shows already exists somewhere: `doctor` returns id, level, state and evidence
per check; `sync` returns a class per path; the invariants table pairs claim with enforcement;
composition models are machine-readable and already render to diagrams. What does not exist is one
object holding all of it, and any way for a person to see where they stand inside it.

## Decision

v5 normalises what is already known before it learns anything new, in four steps that each ship.

**5.0 — the model.** Schema, fixtures, validation. No new inference, no new detector, no new claim.
Nothing consumes the model yet.

**5.1 — `doctor` consumes the model.** It stops assembling the picture itself, and gains
`YOU ARE HERE`: the point on a path from claim to verification where the chain stops being held.
The rule that picks that point lives in the model ([0016](0016-the-model-is-the-source.md)) and is
already pinned by fixture when this step starts.

5.1 must be accepted against a repository carrying **no** `construct.model.json` at all. The model
is written only by `init` and is not materialized from templates, so `sync` never creates one: every
repository materialized before 5.0 and upgraded through `sync` reaches 5.1 without a model, which
makes this the common state on the day it ships, not an edge case. Absent is a third state — not
empty, not malformed — and by [rule 2](../epistemic-rules.md) it is `unknown`. `doctor` must complete
on such a repository and say plainly that it knows nothing about claims there. A `doctor` that fails,
or that reports claims as `absent`, turns missing data into an assertion about enforcement.

5.1 also carries a deferred-question check (L1): inspect `doctor`'s output on this live repository
and record whether a useful diagnosis needs a fact the model cannot currently provide. If one does,
record the missing fact and return to *Where does evidence of enforcement capability belong?* in
[AGENTS.md](../../AGENTS.md). The check is review, and is written down because the question is
deliberately left open until a real diagnosis on a real repository shows what it needs.

**5.2 — the static graph.** The existing model-to-diagram mechanism is fed the new model. No graph
engine. If a static picture already answers *where am I and where is the hole*, the release stands
on its own.

**5.3 — interactivity, and only if 5.2 is used.** Clicking, filtering, drill-down and history carry
no enforcement value; they must earn their place on top of a model people already read.

Discovery grows in parallel and is not part of this sequence: it writes better hypotheses into the
model over time, under [decision 0015](0015-interpretation-stays-with-the-agent.md).

## Consequences

The first release adds no engineering claim and can therefore be wrong about nothing new. The risk
concentrates in 5.3, which is last and conditional rather than first and assumed.

## Enforced by

Review (L1) for the ordering; the per-step acceptance criteria carry their own levels.
