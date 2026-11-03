---
"mikoshi-construct": patch
---

The bus keeps a card's release as a field of the card: `plan --op add` and `plan --op remove` move one card into or out of a release with one `card.planned` or `card.unplanned` event, `intake --release <id>` puts an admitted card into an open release, a release carries its gate, and `plan --op backfill` moves the cards a release's plan items linked onto the field in one event. `plan --op link` is gone, and no command writes a card into a plan item any more.
