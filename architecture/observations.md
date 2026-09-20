# Observations

Decisions are stable; observations accumulate, sharpen and go stale. Keeping them apart is why this
file exists. A decision records what was settled and why, and is amended only when the decision
itself changes. An occurrence of something a decision already describes is recorded here, and the
decision points at this file rather than growing a log inside itself — a record that accumulates
entries eventually gets tidied, and tidying a log into the text of a decision adds scope to it
retroactively, which [epistemic-rules.md](epistemic-rules.md) forbids in its header.

Each entry carries a date, what was observed, and the boundary of what it supports. **An observation
is not a frequency.** Two occurrences of the same failure are two occurrences; the population here is
far too small to carry a rate, and nothing causal is claimed from any of it. The findings corpus
proper lives in a separate private repository
([decision 0001](decisions/0001-findings-corpus-outside-the-cli.md)); this file is what that corpus
can point at.

## 2026-09-21 · `testsWeakened` fired on a second class of change

The ladder's `testsWeakened` guard rejected a change in which tests were deleted **together with the
feature and the modules they covered** — doctor's `hook` and `red-gate` verdicts and their check
files, removed deliberately in v5.1 task 3.

The gate detected the deletion correctly and could not determine whether it was legitimate feature
removal or deletion intended to weaken coverage. A human established legitimacy by matching each
removed test to a removed module or fixture; the surviving `runner.ts` coverage was unchanged, and
the test count rose from 566 to 568.

**Boundary.** Two classes have now been observed: a narrowed assertion inside a live implementation
change, and deletion alongside the code under test. Deletion cases may need human adjudication,
because legitimacy depends on whether the module under test also went. Nothing here says how often
either class occurs.

Related: the open question on enforcement capability in [AGENTS.md](../AGENTS.md).

## 2026-09-21 · The architect returned nothing, again

v5.1 task 3 escalated to `xhigh`. The architect failed structured-output validation five consecutive
times and returned nothing, so no implementer ran from a spec.

This is another occurrence of the failure mode
[decision 0008](decisions/0008-a-retry-buys-a-new-exploration.md) already describes, and it changes
nothing about that decision.

**Boundary.** Recorded as an occurrence only. No frequency and no cause is claimed from it.
