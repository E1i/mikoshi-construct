---
"mikoshi-construct": patch
---

`construct cost` counted every response two or three times, and the numbers this project has been
publishing and deciding with were about twice their true size.

The reader summed the `usage` of every assistant line in an agent's journal. The journal writes one
line per content block of a response — thinking, text, tool call — and repeats that response's `usage`
on each of them. So a run's cost grew with how many blocks its answers happened to be split into. It
now deduplicates by request identifier, and a test fails if it stops: one response counted once
however many lines carry it, two responses counted twice, and a line the runtime recorded without an
identifier still counted, so the fallback is deliberate rather than accidental.

Every figure this defect produced has been re-derived from the run it names and corrected where it was
published. The release note for 0.3.0 and the reasoning-budget guide carry the correction with the
method named rather than a silent swap of digits, and both say plainly that the comparisons they make
are unaffected: the same bias ran through every figure, so what the numbers were used to argue —
that the entry into the repository dominates, that it grows with the repository rather than the task,
that the reasoning class predicts the price poorly — stands exactly as written. What was wrong was
every absolute number. The four architect entries that returned nothing burned 8,312,965 tokens rather
than 18,580,617; the same role grew 1.19M, 2.05M, 3.16M, 3.91M across one day rather than 2.9M to 8.5M.

Decision 0008, which chose `retryLimit: 0`, is amended rather than reopened. Its conclusion survives,
but the ratio under it does not: splitting five architect entries at their first structured-output call
measures the exploration a new entry pays at 385k to 1.48M and one further attempt inside an entry
already paid for at 57k to 100k, so the margin is five to twenty to one and not the thousand to one
the release note claimed. The amendment also records an argument against its own conclusion that the
evidence did not previously contain — a refused answer recovers, twice observed, and the entries that
died had exhausted the runtime's internal attempts — with its price attached and a note that the next
measurement must weigh it again.
