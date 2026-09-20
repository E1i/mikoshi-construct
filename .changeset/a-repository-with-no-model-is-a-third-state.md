---
"mikoshi-construct": patch
---

Two records about a state that is about to become the common one: a repository with no
`construct.model.json` at all.

The model is written only by `init` and is not materialized from templates, so `sync` never creates
one. Every repository materialized before 5.0 and carried forward with `sync` therefore arrives at 5.1
— the step where `doctor` starts reading the model — without a model to read.

5.1's acceptance now requires that case explicitly. Absent is a third state, distinct from empty and
from malformed, and by rule 2 it is `unknown`: `doctor` must complete on such a repository and say
plainly that it knows nothing about claims there. A `doctor` that fails, or one that reports claims as
`absent`, would turn missing data into an assertion about enforcement, which is the error the rule
exists to prevent.

How such a repository eventually gets a model is recorded as an open question rather than settled:
`sync` could write one, an explicit command could, or nothing could until the next `init`. Each trades
differently against the line 0016 draws between file provenance and repository knowledge, and the
no-model acceptance has to land before the choice, not after — it is what makes the cheapest option
survivable.
