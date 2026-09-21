---
"mikoshi-construct": patch
---

An observation: the claim that a second init was fixed, from the day it was made to the day it failed

Decision 0013 measured a second `init` on a 43-path tree, made `construct.json` additive and named
`variants` among the branches that must survive. `docs/guide/upgrading.md` then concluded "That is
fixed: the record is additive now." The second clause was true and tested; the first read as *the
second `init` is fixed*, when what was fixed was its record layer. It shipped in v0.3.0 and stood
through v0.12.2.

The defect rode in on 0013's own sentence — the branches carry the previous entries, "then the
entries this run wrote". `AGENTS.md` is written by every run, so the freshly computed variant always
replaced the carried one, and the record handed the right answer to the caller that computed the
wrong one. The tests held the record's self-consistency and not its stability: the carry-over
assertion was guarded by a clause excluding every path the run wrote, and a case named *is
idempotent* asserted four properties the replacement satisfies. Nothing compared what `init` rendered
across two runs until this week.

The entry is kept because it is the one claim in this corpus with a complete lifespan: when it was
made, what it was measured on, the layer that evidence covered, the layer the sentence claimed, when
it was falsified and by what. It is one claim in one repository and carries no rate.
