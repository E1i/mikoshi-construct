# 0025 — A premise expressible as facts is written as a hypothesis; prose is understood to age

Status: accepted · 2026-09-21

## Context

An audit of the `open-questions` marker found that **three of its four questions asserted something
about this repository that is false today**, and that nothing in the tool could have noticed:

- One said a policy test ships in two presets and that a third has none asserting roles. Measured:
  three presets ship it, and the third's asserts exactly that.
- One carried a paragraph of candidate evidence in the present tense about a claim rendering `held`
  at L3. The claim carries L0 today.
- One said three options were open and none chosen. The third had shipped, in the upgrading guide,
  **the same day** the marker was last revised — and nothing re-read the question in between.

The fourth question's premise measured true. The four were not distinguishable from each other by
reading them; only by checking each against the tree.

[0024](0024-an-absent-claim-is-derived-not-recorded.md) refused to store an absence because a stored
trace states what was true when it was written and goes stale in silence. The marker is that trace,
one level up. It went stale in exactly the way 0024 predicted, and nobody noticed for the same reason:
nothing re-derives it.

## Decision

**Where a question's premise is expressible in the two fact kinds, it is written as a hypothesis in
`construct.model.json` and the question cites it by id. Where the premise is judgment, it stays prose
and is understood to age — and the marker says so rather than implying it is current.**

A hypothesis stands on facts and its state is derived on every read, so it cannot be quietly wrong: a
premise that stops holding reads `unsupported` the next time anybody looks. A question standing on
nothing has no such mechanism, and no amount of care in writing it supplies one.

The split is by nature, not by wording:

| Part | Where it goes |
|---|---|
| *All three documents state the command list* | a hypothesis, standing on one `file-contains` per document |
| *Which of the three should be the source* | prose, because no fact settles it |

This adds no new author value, no new entry kind, no schema change and no `MODEL_VERSION` bump. It
uses what the model already has, on the side it was already for.

## What this does not claim

**It does not make the marker self-maintaining.** The judgment halves still age, and the three that
survive this repair will drift again. What changes is that the parts which *can* be checked are
checked, so the next drift is narrower and the marker no longer asserts, by its silence, that
everything in it was verified.

**It does not make prose wrong.** An interpretation the two fact kinds cannot carry belongs in the
marker, exactly as the discovery protocol says. This record is about the premises that could have
been facts and were left as sentences.

## Consequences

Each surviving question now says what it stands on: a hypothesis id, or nothing. "Or nothing" is the
honest answer for a question that is pure judgment, and reading it should feel different from reading
one with an id under it.

A premise measured false is removed rather than reworded. Rewording would leave a question that has
been quietly narrowed to fit what happens to be true, which is the same defect wearing a correction's
clothes.

## Enforced by

Review (L1), and partially the model itself: the premises promoted to hypotheses are re-derived by
`doctor` on every run, so those cannot go stale silently again. Nothing mechanically prevents a new
question from being written with a checkable premise left as prose — that remains a thing a reviewer
notices, and this record is what they notice it against.
