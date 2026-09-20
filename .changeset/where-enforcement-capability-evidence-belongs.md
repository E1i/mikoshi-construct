---
"mikoshi-construct": patch
---

A question this line of work opened is now recorded as open rather than carried in a thread.

The model represents the declared enforcement mechanism and evidence that the mechanism exists and
runs. It does not represent evidence that the mechanism can actually fail when the invariant it
protects is violated — and those are different facts. A workflow that runs is not the same as a
workflow that would catch anything.

Two kinds of evidence for that capability have now been seen. Harness mutation tests are the
deliberate kind. The atomicity work added an observed one: the ladder's `testsWeakened` guard caught a
narrowed assertion inside a live implementation change, not in a fixture built to be caught. Whether
enforcement capability is therefore a fact about a repository that the model should carry, or process
evidence belonging to the corpus and the harness history, is genuinely undecided.

It stays undecided on purpose. The question is not resolvable before `doctor` reads the model on a
real repository and a real diagnosis shows what it actually needs, so 5.1 carries a review-level check
that looks for exactly that and returns here if it finds one.

Until then the blind spot is represented by the absence of a question the model can answer. It is not
represented by an `unknown` value or any derived equivalent, because `unknown` asserts that something
was asked and came back empty, and nothing has been asked.
