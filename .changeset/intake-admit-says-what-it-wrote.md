---
"mikoshi-construct": minor
---

cli: `construct intake --admit` no longer says that `task:start` and the shift take the card it admitted. It prints what the run wrote: the card's `intake` line in the journal, and that no bus was wired, so no `card.admitted` was written. `task:start` and the shift are not part of the published CLI, so the old line promised something no generated project has.
