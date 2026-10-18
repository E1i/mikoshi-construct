---
"mikoshi-construct": minor
---

cli: `construct cost` takes a closed cheap card, its pull request and its tasks from the cards, prs and tasks projections in the bus database (`CONSTRUCT_BUS_DB`, default `~/.construct/bus.db`), so cards closed after the journal half of history ends are counted instead of reported as not read
