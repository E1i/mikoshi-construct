---
"mikoshi-construct": patch
---

A card whose pull request closed without merge, with no pull request of it still open, no longer holds its lane, and its next admission opens a new run that launch takes; before, the start with the closed pull request kept the card running for ever and a re-admitted card was never launched. A pull request still open, or one that merged, keeps the run.
