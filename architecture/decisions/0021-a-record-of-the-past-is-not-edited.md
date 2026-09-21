# 0021 — A record of what a past version said is not edited to match what is true now

Status: accepted · 2026-09-21

## Context

[0019](0019-a-specimen-is-described-by-structure.md) exempts a frozen fixture from the rewriting it
otherwise requires, and gives the reason: the fixture states what a past version wrote, so editing it
would make this repository's own history assert something it never asserted. That reason was written
as a property of one kind of file.

It is not. Removing a foreign repository's problem domain from the harness-steps facts meant
correcting the prose that listed the harness steps, and one file listing them was a published release
note describing what an earlier version shipped. It was left alone, for exactly 0019's reason — but
that file **contains no specimen and no address**, so the case cannot be a carve-out from a rule
about how specimens are described. Two different axes had met in one paragraph by accident, because a
frozen fixture happened to be a file that also carried an address:

| Record | Axis |
|---|---|
| 0019 | what may be named — a specimen's identity |
| 0021 | what may be rewritten — a record's tense |

## Decision

**A record of what a past version said is not edited to match what is true now.**

A frozen fixture under `tests/fixtures/`, a published release note, a dated entry in
`observations.md` — each exists to state what was the case at a particular version or on a particular
day, and rewriting one makes this repository's own history assert something it never asserted. The
test is not the file's location but its tense: if the artifact's job is to state what was true then,
it is not corrected when that stops being true. What replaces a correction is a new record, dated,
that says what changed.

The third instance records existing practice rather than proposing anything. The dated entries in
`observations.md` already work this way, and one of them says so in its own words: where a second run
superseded a first, the later entry states that the earlier one "is not edited: it records what was
seen then, and its value is its date", and that the two sets of numbers are two runs rather than a
discrepancy between one right and one wrong. This record generalises a practice the file was already
following, which is why it asks for no change to anything written under it.

**This record does not reopen anything already left alone.** It states the rule those decisions were
already following. An artifact that was correctly not edited stays not edited, and nothing here asks
for a pass over the history to find more of them.

## Boundary

Two instances, one day, one repository. That is enough to name the class and not enough to claim a
rate, and nothing here says how often the situation arises. The second instance is what showed the
class was wider than the file type the first one had — one occurrence looked like a fact about
fixtures.

## Relationship to 0019

0019 keeps its own paragraph on the frozen fixture, including the note that the plausible mechanical
reason for that exemption is false. That note is about one fixture and is needed nowhere else, so it
is not restated here. 0019 gains a pointer to this record and no scope of its own: its subject is
still what may be named, and a claim about what may be rewritten would be new scope that, by this
repository's own convention, takes a new number rather than widening an existing entry.

## Consequences

A correction that cannot be made in place has to be made as an addition, which is slower and leaves
the older statement visible beside the newer one. That is the intended shape: a reader who finds the
old statement can see what replaced it, where an in-place edit would have left them believing the
repository had always said the new thing.

The cost is that a stale sentence stays reachable and may be read on its own. Where that matters, the
remedy is a pointer from the old record to the new one, not an edit to the old record's claim.

## Enforced by

Review (L1). Nothing mechanical distinguishes a record whose job is to state what was true then from
one that describes what is true now — the test is the artifact's tense, which no checker reads. The
practical guard is that these artifacts are few and named above, and that a correction proposed
against one of them should be turned into a new dated record instead.
