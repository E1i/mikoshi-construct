---
"mikoshi-construct": patch
---

The enforcement scale now states the assumption every level above L0 was already making: the
mechanism must be able to **report a failure**.

L3 read as "CI that does not block a merge", which literally describes a job carrying
`continue-on-error` — it is CI, and it does not block. The wording presumed a check capable of
failing and distinguished L3 from L4 by whether the failure blocks, without ever saying so. The
distinction between L0 and L3 is whether a failure can be raised at all, and that half was never
written down.

A check that is green whether or not the invariant holds reports nothing and is L0, however much
machinery stands behind it.

This is a precondition being written out, not scope being added: it is what the levels already
assumed, and exactly one record was affected by the gap — the dependency-audit claim corrected in
this same release. Writing it now, while that single case is known and already repaired, means the
sentence reclassifies nothing retroactively. Left for later it would silently move an unknown number
of past records, and nobody would be able to tell a clarification from a change of scope.
