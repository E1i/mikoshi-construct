---
"mikoshi-construct": minor
---

cli: when a caller wires a bus into `construct intake`, a card admitted, amended or moved after `2026-10-12T17:04Z` is recorded only as `card.admitted` or `card.moved` in the bus, with no `intake` or `intake-move` line in the journal, and numbers, admissions and amendments read the bus for that time; without a bus, as in the published CLI, the journal lines are written as before
