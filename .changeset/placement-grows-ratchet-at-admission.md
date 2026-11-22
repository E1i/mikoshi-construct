---
'mikoshi-construct': patch
---

`construct intake` takes an optional per-card draft field `imports`, a list of `{ "from", "to" }` repository paths: the imports the card's placement requires. Intake maps each to its boundary row with the module ownership the ratchet's boundary report uses and marks `touches` unclear for every row whose count would exceed its count in `contract/ratchet.json`, naming the row, its count now and after, and both files, so the card stays `who: window` until a person re-places it. The field is not written into the parking card.
