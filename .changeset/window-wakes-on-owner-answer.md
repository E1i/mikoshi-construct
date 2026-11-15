---
'mikoshi-construct': patch
---

cli: `miko:watch` wakes the window when the owner answers a wait it handed over: `owner.wait.closed` and `decision.recorded` on a card with an open owner wait or in `card.waiting` now return `miko:watch --once` with that event, named by the card; the same events on a card with no open wait stay silent.
