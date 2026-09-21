---
"mikoshi-construct": patch
---

Decision 0027: an acceptance is red before the implementation exists

The lifecycle had an unnamed stage between the brief and the implementation, and it had been doing
real work. It is acceptance discipline, and it is not the reasoning ladder: one answers whether we
may proceed to reasoning at all, the other how much reasoning to give once the harness says the
solution does not work. A new normative area takes a new number rather than widening the ladder into
a job it never had.

The rule is one mechanical test. A criterion that cannot be shown failing is a statement of intent
however specific its wording, and the discriminator for every checkpoint in the stage is that it is
met by producing something a second party can check rather than by an answer about one's own work.
Two stops come with it — a baseline that cannot be reproduced is reported rather than assumed, and a
criterion is never adjusted to make the test green — and one condition, that the party writing the
acceptance is not the party measuring it.

`the-cycle.md` §3 keeps both of its existing rules, which the record names individually: the first
bounds what a criterion may depend on and survives untouched, the second orders tasks and is not
about criteria at all. Neither provides red-before-implementation, so the third statement lives in
the decision and §3 points at it.

The record carries L1 and says why: nothing today can report a violation, so by this repository's own
observation it is a rule carried by memory. What would make it L3 is named and not built.

The record carries two things a later reader would otherwise have to rediscover. The chain of
carriers has a stated end — it stops at the first level where enforcement can fail without a human
deciding it has failed, and where that failure has been demonstrated on a real case the carrier was
expected to catch — with both clauses shown against examples already here: the dependency audit under
`continue-on-error` fails the first, and the post-publish smoke satisfies the second by having been
run red on 0.12.2 and green on 0.13.0. And the path to enforcement is written as three rungs rather
than one, because the middle rung — the planning agent reading the rule — is necessary, is still L0,
and is the one that will be reported as completion.

