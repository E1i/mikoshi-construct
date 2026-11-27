---
'mikoshi-construct': patch
---

Three more readers leave the no-foreign-table-sql exceptions and go through the operations of the tables' owners. The legacy journal history reads its rows through the bus's `events` query. The parking reads take card bodies, their depends and card states from card-record's `cardBodyLanes`, `cardBodyText` and `cardStatesAmong`. The intake's XS whole-card reason now says the slices would be "one change split across cards that wait on each other": the old wording, "cut into cards", read to the rule as SQL naming the `cards` table. What these readers return does not change.
