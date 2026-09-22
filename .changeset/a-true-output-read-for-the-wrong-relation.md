---
"mikoshi-construct": patch
---

An observation: a true output read for the wrong relation, and the refusal that ended it

A false premise entered a task brief from the reviewing session, survived the owner re-running the
command it rested on, and was stopped at the implementer by a measurement. `git tag | tail -3` was
read as the three newest versions; it answers the last three lexicographically, and here those are
`v0.8.0`, `v0.9.0`, `v0.9.1`, because `9` sorts after `1`. From that reading followed a count of
untagged releases, a claim about what the release action pushes, and a claim that the header comment
in `release.yml` is false — two briefed pull requests, and a correction drafted for a changeset.
`git tag --sort=v:refname` ended it: 31 tags against 32 published versions, one gap at `0.1.0`, which
is the version `release.yml` already documents as published by hand before trusted publishing could
work.

What makes the specimen worth recording is that the command succeeded. Its exit status was zero, its
output was real, every tag it printed exists, and re-running it reproduced the same three lines. Only
the relation between that output and the question was wrong. A failure would have announced itself;
this did not, and the second run — by a second person — read as confirmation rather than as a
repetition of the same reading.

The entry states two readings and promotes neither. It is a third instance of a valid result read as
evidence for a different relation, after `git ls-files` in decision 0014 and a commit range read for a
temporal question; all three are git, in each case the default output answered an adjacent question —
what is listed rather than what is tracked, ancestry rather than time, lexicographic rather than
version order — and in each case a flag existed that would have answered the question asked. Three
instances on one mechanism are material for the entry and are not grounds to extend anything, the
trigger for that being a third instance on a different mechanism. And the carrier that stopped it was
neither a check nor a rule but the implementer declining to write code from a brief that did not match
the tree: the fourth refusal to build recorded here, and the first where the refusal kept a false
statement out of a published record rather than out of an unbuilt artifact.

No remedy is proposed and nothing is promoted to a decision or a rule. The boundary is one premise,
one night, one project and three parties — a form, not a rate, and nothing about how often a true
output is read for the wrong relation.
