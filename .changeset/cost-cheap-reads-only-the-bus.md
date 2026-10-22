---
"mikoshi-construct": minor
---

cli: `construct cost` no longer opens `~/.construct/handoff/ghosts.jsonl`. The cheap forecast reads the window's journal half of history from the legacy lines of the bus database (`CONSTRUCT_BUS_DB`, default `~/.construct/bus.db`), and counts every session a closed card's `card.started` and `card.answered` events name, its minutes from the first start. `cheap.windowJournal` in the cost report is now `cheap.bus`.
