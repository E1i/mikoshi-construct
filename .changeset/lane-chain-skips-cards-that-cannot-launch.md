---
'mikoshi-construct': patch
---

A lane chain orders a card only after cards that can still launch: a dropped card, and a card whose depends reach a dropped card through any chain of depends, leave every chain, and a queued card already chained behind one of them is laid out again on the next lane layout. A queued card whose depends name a dropped card opens one owner wait (`need: decision`) naming both cards, once per card and dependency; the card itself is neither dropped nor amended.
