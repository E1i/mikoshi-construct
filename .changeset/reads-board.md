---
'mikoshi-construct': patch
---

`construct board` reads the tables of other owners through their operations instead of its own SQL. The cards with their lines, the open tasks, the events, the node slots, the bus panel, the drains and the last heal come through `scripts/core/card-readings.ts`, which takes the events and tasks from `events-query.ts` and `tasks-query.ts`. The stale-pass and stall warnings read the pull requests through `pr-readings.ts`. `bus-panel.ts`, `drain.ts`, `heal.ts` and `scripts/cli/board-warnings.ts` have left the no-foreign-table-sql exceptions. What the board shows does not change.
