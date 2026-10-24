---
"mikoshi-construct": patch
---

cli: `construct intake --move <card> --to <dir>` accepts a sliced stub, a parked file whose whole text is `sliced into #<child>, #<child>`, which it used to refuse for naming no `who:`. Moving one, into any directory, writes `card.dropped` with the stub's line as `reason` and the child numbers as `children`, so the parent card leaves the bus queue and its lane instead of staying queued. The bus rejects a `card.dropped` whose `children` are not card numbers other than the dropped card, or that names children without a reason.
