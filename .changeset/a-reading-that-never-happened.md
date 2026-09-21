---
"mikoshi-construct": patch
---

Observation: a command that did not run, read as a measurement that did

Two cases on one machine in one day, under the same broken shim: a scan reported pull request bodies
clean from a run where the tool was never found, and an `evidenceClean` computation would have
written `true` for five hypotheses from a `git` that never executed.

Recorded as one shape rather than as two tool problems — a command fails, returns empty, and the
empty is read as a successful measurement. The entry keeps the part that makes it worth recording:
the failure was visible only because an unrelated expectation happened to contradict the value, and
on a clean tree the failed measurement and the correct answer coincide exactly. Catching it was luck.

The requirement it leaves is procedural, not a check for a missing binary: a result is not a
measurement merely because it has the expected shape; the measurement must also evidence that it was
performed. Where a hypothesis depends on one that cannot show it ran, no hypothesis is written.
