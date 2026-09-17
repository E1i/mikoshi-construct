---
"mikoshi-construct": patch
---

The ladder's design step lived outside the rung loop, and that single placement made three claims false at once: a run reported an effort class whose defining step had not executed, the attempts list claimed to record every failed attempt and did not, and the status reported success for a run that had silently degraded. Observed for real — an architect failed schema validation, returned nothing, and the run went on without a design, reported `high, done, one attempt, passed`, and delivered work in which a prohibition was left living in the prose of a decision record instead of in the code. A person found that by hand; nothing in the harness could have.

Design is now part of a run. Its outcome is recorded in `attempts` like any other, a failed architect blocks a `high` run rather than letting it continue undesigned — `high` is chosen exactly where a green harness proves the least — a `low` or `medium` run may continue but ends as `degraded` rather than as a plain success, and the effort a run reports describes what actually executed, so a run without a design does not call itself `high`.

Decision 0011 records that a retry limit of zero was and remains right: it saved a second full agent entry of about 2.6M tokens and worked as designed. What was missing was a described path for the case it creates, and an unspecified fallback is how a correct decision produces an incorrect run.

The ledger reader also gains a stated invariant it previously held by accident: a line whose status or attempt outcome this version has never heard of reads as valid rather than malformed, because a newer CLI writes the ledger an older one reads.
