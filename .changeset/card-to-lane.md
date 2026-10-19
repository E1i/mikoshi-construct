---
"mikoshi-construct": minor
---

cli: `construct intake` run without `--parking` now places each card it writes in a lane of the parking. A card goes to the lane that holds a card it depends on. Otherwise it goes to the first lane whose touches overlap its own; a lane's touches are those its `lane.json` lists plus those of the cards parked in it. Otherwise intake opens a new `lane-NN` and writes its `lane.json`. The `card.admitted` event names that lane. With `--parking`, the card is written to that directory as before.
