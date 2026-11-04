---
"mikoshi-construct": patch
---

A test under `apps/<name>/tests` or `packages/<name>/tests` that imports a touched file now counts as covering it, so intake puts it in the card's runs and a card that changes it opens its pull request instead of stopping outside its touches.
