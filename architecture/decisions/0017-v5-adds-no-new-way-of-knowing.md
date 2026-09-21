# 0017 — v5 adds no new way of knowing

Status: proposed · 2026-09-20

## Context

Everything this work shows already exists somewhere: `doctor` returns id, level, state and evidence
per check; `sync` returns a class per path; the invariants table pairs claim with enforcement;
composition models are machine-readable and already render to diagrams. What does not exist is one
object holding all of it, and any way for a person to see where they stand inside it.

## Decision

v5 normalises what is already known before it learns anything new, in four steps that each ship.
The steps carry names rather than numbers, so that no step can be read as a release version: at
0.5.4 the model and the projection have shipped and the picture has not been started.

**The model.** Schema, fixtures, validation. No new inference, no new detector, no new claim.
Nothing consumes the model yet.

**The projection — `doctor` consumes the model.** It stops assembling the picture itself, and gains
`YOU ARE HERE`: the point on a path from claim to verification where the chain stops being held.
The rule that picks that point lives in the model ([0016](0016-the-model-is-the-source.md)) and is
already pinned by fixture when this step starts.

The projection must be accepted against a repository carrying **no** `construct.model.json` at all.
The model is written only by `init` and is not materialized from templates, so `sync` never creates
one: every repository materialized before 0.5.0 and upgraded through `sync` arrives at this step
without a model, which makes it the common state on the day it ships, not an edge case. Absent is a third state — not
empty, not malformed — and by [rule 2](../epistemic-rules.md) it is `unknown`. `doctor` must complete
on such a repository and say plainly that it knows nothing about claims there. A `doctor` that fails,
or that reports claims as `absent`, turns missing data into an assertion about enforcement.

The projection is not closed by the release that ships it. Its last acceptance criterion runs on a
real adopted repository: sync one to the published version, run `doctor` there, and record the inspection —
including the outcome "no gap found", with the date and the commit it was run against. An adopted
repository brings what no fixture does, because its runner config was written by its owner rather
than by the construct, so it is the only place `uncollectedTests` staying silent can actually be
observed. An unexamined case and an examined one with no finding are indistinguishable unless the
examination is written down.

Run first on 2026-09-21 against a **diverged construct repository** — materialized by `init` at 0.1.1
and since diverged on 16 paths — which found the baseline defect fixed in #71 and produced the first
candidate evidence on the enforcement-capability question. That run did not discharge this criterion,
because the tree was one the construct itself materialized.

**Discharged the same day** against repositories the construct never materialized, adopted by running
`init` into copies of them. The criterion is better stated as *written to other conventions* than as
*not materialized by us*: the first specimen was never touched by the construct and held every claim
anyway, because its author works to the same standards, so "we did not build it" turned out not to be
what tests generality. One, built to conventions close to the construct's, held every
claim; the other, built to different ones, produced the first chain on any real repository that stops
in the middle, and the first `YOU ARE HERE` pointing at a fact that stopped matching. Both are
recorded in [architecture/observations.md](../observations.md), along with what they still do not
establish.

The projection also carries a deferred-question check (L1): inspect `doctor`'s output on this live
repository and record whether a useful diagnosis needs a fact the model cannot currently provide. If one does,
record the missing fact and return to *Where does evidence of enforcement capability belong?* in
[AGENTS.md](../../AGENTS.md). The check is review, and is written down because the question is
deliberately left open until a real diagnosis on a real repository shows what it needs.

**The picture — the static graph.** The existing model-to-diagram mechanism is fed the new model.
No graph engine. If a static picture already answers *where am I and where is the hole*, the release stands
on its own.

**The interaction — and only if the picture is used.** Clicking, filtering, drill-down and history
carry no enforcement value; they must earn their place on top of a model people already read.

Discovery is not part of this sequence and has one step of its own. **The discovery protocol writes
hypotheses into the model**, as its own step after the markers rather than as a reading of them: the
markers are prose answering *what is where*, a hypothesis is a structural record answering *what this
is*, standing on the same two fact kinds and no third, under
[decision 0015](0015-interpretation-stays-with-the-agent.md).

The step is prose an agent may or may not follow, so its level is **L0**. The change that added it
proves three things and no more: that the step materializes with the rest of the protocol, that the
worked example in it parses against the schema with every entry authored by `discovery`, and that a
discovery-authored hypothesis survives the next `init` while the construct-authored half is rewritten
byte for byte. That discovery in fact writes a hypothesis into a real repository's model is shown only
by a live run on one, which is separate work and has not been done. Nothing here demonstrates the
capability, and nothing enforces it.

## Consequences

The first release adds no engineering claim and can therefore be wrong about nothing new. The risk
concentrates in the interaction, which is last and conditional rather than first and assumed.

## Enforced by

Review (L1) for the ordering; the per-step acceptance criteria carry their own levels.
