---
"mikoshi-construct": minor
---

cli: `construct intake --admit` amends a card the journal already admitted when its card line, task text or witnesses changed: the card is checked with the parking grammar and gets a new `intake` line with `"source":"amend"`, instead of a report that it is already admitted. Every `intake` line now records `bodySha`, the digest of the card's text below its header; an unchanged admitted card still writes nothing.
