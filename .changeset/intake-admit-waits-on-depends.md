---
"mikoshi-construct": minor
---

`construct intake --admit` no longer admits a card whose `depends` name a card that is not merged: the card stays parked, a bus-wired run records a `card.waiting` naming those cards, and the exit is `3`. An amend of an admitted card is not affected.
