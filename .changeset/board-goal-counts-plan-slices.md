---
"mikoshi-construct": minor
---

cli: `construct board` opens with one line per open plan, read from the plan journal in the bus instead of a release number guessed from card text: `<plan>: delivered N of M · queued · in progress · review · slices without cards: K · +X in 24 h · backlog: B`. A slice counts as delivered only when every card linked to it is merged; a dropped card does not count, a second card on one slice does not grow the total, and a card linked to no slice is in the backlog. A closed plan leaves the board. A bus with no open plan shows no plan line.
