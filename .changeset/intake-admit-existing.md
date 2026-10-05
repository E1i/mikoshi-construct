---
"mikoshi-construct": minor
---

cli: `construct intake --admit <parking>/<id>.md` admits a card parked before intake confirmed cards: it checks the card by facts under its own number, holds a correction until a person confirms it, and writes the card's `intake` line, so `task:start` and the shift take it.
