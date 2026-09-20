---
"mikoshi-construct": patch
---

The rule that a normative scope is fixed once written now has an audit behind it, and one gap it found
has a check.

Two identifier vocabularies in this repository are cited by name and would rewrite history if their
meanings moved: `doctor`'s check ids, which every report already published asserts something with, and
the enforcement levels L0–L4, which every invariant already recorded at L3 depends on.

The check ids are clean. Five ids in five files, each declaring its own and emitting no other, and `ci`
goes further by naming in a constant what it cannot see — branch protection lives in the GitHub API —
rather than quietly covering it.

The levels were not. They were spelled out twice in code, once for `doctor` and once for the model,
with nothing tying the copies together. They agreed, so nothing was wrong; but either could have been
widened on its own and no check would have failed, which is precisely the silent move the scope rule
forbids. A test now holds the two lists to each other, verified by widening one and watching it fail.

The audit is recorded with its date and with what it inspected, because an unexamined vocabulary and a
clean one look identical from the outside.
