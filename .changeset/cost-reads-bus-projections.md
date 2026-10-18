---
"mikoshi-construct": minor
---

cli: `construct cost` takes a closed cheap card from the cards and card_bodies projections and its start and close events in the bus database (`CONSTRUCT_BUS_DB`, default `~/.construct/bus.db`), so cards closed after the journal half of history ends are counted instead of reported as not read
